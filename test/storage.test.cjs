const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StudioStorage } = require('../src/core/storage.cjs');

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-engagement-studio-'));
  const legacyStatePath = path.join(dataDir, 'state.json');
  const legacyLedgerPath = path.join(dataDir, 'engagement-ledger.jsonl');
  return { dataDir, legacyStatePath, legacyLedgerPath };
}

test('storage migrates legacy JSON and JSONL into a transactional store with backups', () => {
  const files = tempStore();
  fs.writeFileSync(files.legacyStatePath, JSON.stringify({ schema: 'legacy', profile: { name: 'Migrated profile' } }));
  fs.writeFileSync(files.legacyLedgerPath, `${JSON.stringify({ receiptId: 'legacy-1', idempotencyKey: 'legacy-key', status: 'LIVE_VERIFIED', createdAt: '2026-08-20T00:00:00.000Z' })}\nnot-json\n`);
  const storage = new StudioStorage(files).open({ defaultState: { schema: 'default' } });

  assert.equal(storage.loadState({ schema: 'default' }).profile.name, 'Migrated profile');
  assert.equal(storage.readLedger().length, 1);
  assert.ok(fs.readdirSync(path.join(files.dataDir, 'backups')).some((name) => name.startsWith('state.json.pre-sqlite-')));
  assert.ok(fs.existsSync(path.join(files.dataDir, 'social-engagement-studio.sqlite')));
  storage.close();
});

test('connected accounts keep provider identity immutable and retain independent policy', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  const account = storage.registerAccount({
    accountId: 'facebook:page-1',
    platform: 'facebook',
    providerAccountId: 'page-1',
    displayName: 'Research Page',
    credentialRef: 'meta:page:page-1',
    capabilities: { comment: true, reply: true },
    policy: { maxActionsPer24Hours: 4 },
  });
  assert.equal(account.providerAccountId, 'page-1');
  assert.equal(storage.getAccount('facebook:page-1').policy.maxActionsPer24Hours, 4);
  assert.throws(() => storage.registerAccount({ ...account, providerAccountId: 'page-2' }), /immutable/);
  assert.throws(() => storage.registerAccount({ ...account, accountId: 'facebook:page-2', providerAccountId: 'page-1' }), /conflict/);
  storage.close();
});

test('UNKNOWN receipts enter reconciliation and only an evidence-bearing final receipt closes it', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  storage.appendReceipt({
    receiptId: 'yt-unknown-1',
    idempotencyKey: 'same-action',
    status: 'UNKNOWN',
    platform: 'youtube',
    actorAccountId: 'youtube:channel-1',
    targetAccountId: 'channel-2',
    error: 'youtube_readback_mismatch',
    createdAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(storage.listReconciliation().length, 1);
  assert.throws(() => storage.resolveReconciliation({ idempotencyKey: 'same-action', resolution: 'FAILED', resolvedBy: 'operator' }), /evidence/);
  const final = {
    receiptId: 'yt-unknown-1-reconciled',
    idempotencyKey: 'same-action',
    status: 'LIVE_VERIFIED',
    platform: 'youtube',
    actorAccountId: 'youtube:channel-1',
    targetAccountId: 'channel-2',
    commentText: 'approved text',
    providerId: 'comment-1',
    providerReadBack: [{ providerId: 'comment-1', exact: true, exactText: 'approved text', verifiedAt: '2026-08-20T00:01:00.000Z' }],
    resolvedBy: 'youtube-reconcile',
    resolution: 'provider_confirmed',
    createdAt: '2026-08-20T00:01:00.000Z',
  };
  const appended = storage.appendReceipt(final);
  assert.equal(appended.inserted, true);
  assert.equal(storage.listReconciliation().length, 0);
  assert.equal(storage.listReconciliation({ unresolvedOnly: false })[0].resolvedBy, 'youtube-reconcile');
  assert.equal(storage.readLatestReceipt('same-action').status, 'LIVE_VERIFIED');
  assert.equal(storage.listEvaluationExamples().length, 1);
  assert.equal(storage.listEvaluationExamples()[0].providerReadBack[0].exact, true);
  storage.close();
});

test('a dispatched receipt remains visible if the process stops before the provider outcome is recorded', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  storage.appendReceipt({ receiptId: 'dispatched-1', idempotencyKey: 'dispatched-key', status: 'DISPATCHED', platform: 'facebook', createdAt: '2026-08-20T00:00:00.000Z' });
  const item = storage.listReconciliation()[0];
  assert.equal(item.idempotencyKey, 'dispatched-key');
  assert.equal(item.reasonCode, 'dispatched_without_final_state');
  storage.close();
});

test('secure secret references store only ciphertext and actor budget queries stay platform-scoped', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  storage.setSecret('meta:page:page-1', 'ciphertext-not-token');
  assert.equal(storage.getSecret('meta:page:page-1'), 'ciphertext-not-token');
  storage.appendReceipt({ receiptId: 'a-1', idempotencyKey: 'a-1', status: 'LIVE_VERIFIED', platform: 'facebook', actorAccountId: 'facebook:page-1', createdAt: '2026-08-20T00:00:00.000Z' });
  storage.appendReceipt({ receiptId: 'a-2', idempotencyKey: 'a-2', status: 'LIVE_VERIFIED', platform: 'instagram', actorAccountId: 'facebook:page-1', createdAt: '2026-08-20T00:00:00.000Z' });
  assert.equal(storage.countActorActions({ actorAccountId: 'facebook:page-1', platform: 'facebook', since: '2026-08-19T00:00:00.000Z' }), 1);
  assert.equal(storage.countActorActions({ actorAccountId: 'facebook:page-1', platform: 'instagram', since: '2026-08-19T00:00:00.000Z' }), 1);
  storage.close();
});

test('metric snapshots and exemplars are provider-scoped and immutable', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  storage.saveMetricSnapshot({ platform: 'youtube', targetAccountId: 'channel-1', actionId: 'video-1', metricName: 'views', value: 42, source: 'youtube_data_api:videos', observedAt: '2026-08-20T00:00:00.000Z' });
  assert.equal(storage.listMetricSnapshots({ platform: 'youtube' })[0].value, 42);
  const exemplar = storage.pinExemplar({ exemplarId: 'ex-1', platform: 'youtube', action: 'comment', text: 'The retest is the useful confirmation; what would invalidate it?', evidence: ['retest'], sourceHash: 'hash-1', version: 1 });
  assert.equal(exemplar.status, 'APPROVED');
  assert.throws(() => storage.pinExemplar({ exemplarId: 'ex-1', platform: 'youtube', action: 'comment', text: 'Changed copy', evidence: ['retest'], sourceHash: 'hash-2', version: 1 }), /immutable/);
  storage.close();
});

test('verified evaluation examples are immutable and only created from evidence-bearing live receipts', () => {
  const files = tempStore();
  const storage = new StudioStorage(files).open({ defaultState: {} });
  storage.appendReceipt({
    receiptId: 'verified-example-1',
    idempotencyKey: 'verified-example-key',
    status: 'LIVE_VERIFIED',
    platform: 'youtube',
    action: 'comment',
    actorAccountId: 'youtube:channel-1',
    targetAccountId: 'channel-2',
    commentText: 'The retest is the useful confirmation.',
    contextFingerprint: 'context-hash',
    evidenceLocators: ['transcript:00:12'],
    gateScore: 0.94,
    gateVerdict: 'PASS',
    providerReadBack: [{ providerId: 'comment-1', exact: true, exactText: 'The retest is the useful confirmation.' }],
    applicationCommit: 'abc123',
    liveVerifiedAt: '2026-08-20T00:02:00.000Z',
  });
  storage.appendReceipt({
    receiptId: 'not-an-example',
    idempotencyKey: 'no-evidence-key',
    status: 'LIVE_VERIFIED',
    platform: 'youtube',
    action: 'comment',
    commentText: 'Missing provider evidence',
  });
  const examples = storage.listEvaluationExamples({ platform: 'youtube' });
  assert.equal(examples.length, 1);
  assert.equal(examples[0].immutable, true);
  assert.equal(examples[0].contextFingerprint, 'context-hash');
  assert.deepEqual(examples[0].evidence.evidenceLocators, ['transcript:00:12']);
  storage.close();
});

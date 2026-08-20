const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  const unavailable = new Error('This desktop runtime does not provide node:sqlite; the multi-account store cannot start safely.');
  unavailable.code = 'sqlite_runtime_unavailable';
  unavailable.cause = error;
  throw unavailable;
}

const ACTIVE_SCHEMA_VERSION = 2;
const LIVE_COUNTED_STATUSES = new Set(['DISPATCHED', 'PROVIDER_ACCEPTED', 'UNKNOWN', 'LIVE_VERIFIED']);
const RECONCILIATION_OPEN_STATUSES = new Set(['DISPATCHED', 'PROVIDER_ACCEPTED', 'UNKNOWN']);
const RECONCILIATION_FINAL_STATUSES = new Set(['LIVE_VERIFIED', 'FAILED']);

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    return fallback;
  }
}

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch (error) {
    return JSON.stringify(fallback);
  }
}

function eventIdFor(receipt) {
  return crypto.createHash('sha256').update(JSON.stringify(receipt), 'utf8').digest('hex');
}

function timestampForFilename(value = nowIso()) {
  return String(value).replace(/[:.]/g, '-');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

class StudioStorage {
  constructor({ dataDir, dbPath, legacyStatePath, legacyLedgerPath, now = nowIso } = {}) {
    this.dataDir = dataDir || process.cwd();
    this.dbPath = dbPath || path.join(this.dataDir, 'social-engagement-studio.sqlite');
    this.legacyStatePath = legacyStatePath || path.join(this.dataDir, 'state.json');
    this.legacyLedgerPath = legacyLedgerPath || path.join(this.dataDir, 'engagement-ledger.jsonl');
    this.now = now;
    this.db = null;
    this.recovery = null;
    this.migration = { importedState: false, importedLedgerRows: 0, malformedLedgerLines: 0, backups: [] };
  }

  open({ defaultState = {} } = {}) {
    ensureDirectory(path.dirname(this.dbPath));
    const databaseExisted = fs.existsSync(this.dbPath);
    try {
      this.db = new DatabaseSync(this.dbPath);
    } catch (error) {
      if (!databaseExisted) throw error;
      const corruptPath = `${this.dbPath}.corrupt-${timestampForFilename(this.now())}`;
      fs.renameSync(this.dbPath, corruptPath);
      this.recovery = { corruptPath, reason: 'sqlite_open_failed' };
      this.db = new DatabaseSync(this.dbPath);
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.applyMigrations();
    if (!databaseExisted || this.recovery) this.backupLegacyFiles();
    this.importLegacyState(defaultState);
    this.importLegacyLedger();
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  assertOpen() {
    if (!this.db) throw new Error('SQLite storage is not open');
  }

  applyMigrations() {
    this.assertOpen();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version));
    if (!applied.includes(1)) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_name TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS actor_accounts (
          account_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          credential_ref TEXT NOT NULL DEFAULT '',
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          policy_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'disconnected',
          status_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (platform, provider_account_id)
        );
        CREATE TABLE IF NOT EXISTS secure_secrets (
          secret_ref TEXT PRIMARY KEY,
          cipher_text TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ledger_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT,
          receipt_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          platform TEXT,
          actor_account_id TEXT,
          target_account_id TEXT,
          provider_id TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ledger_events_idempotency_idx ON ledger_events (idempotency_key, sequence);
        CREATE INDEX IF NOT EXISTS ledger_events_actor_idx ON ledger_events (actor_account_id, platform, created_at);
        CREATE TABLE IF NOT EXISTS reconciliation_inbox (
          idempotency_key TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'OPEN',
          reason_code TEXT NOT NULL DEFAULT 'unknown_mutation',
          action_event_id TEXT NOT NULL,
          provider_evidence_json TEXT,
          resolved_by TEXT,
          resolved_at TEXT,
          resolution TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reconciliation_status_idx ON reconciliation_inbox (status, updated_at);
        CREATE TABLE IF NOT EXISTS metric_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          actor_account_id TEXT,
          target_account_id TEXT,
          action_id TEXT,
          metric_name TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS metric_snapshot_target_idx ON metric_snapshots (platform, target_account_id, observed_at);
        CREATE TABLE IF NOT EXISTS exemplars (
          exemplar_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          action TEXT NOT NULL,
          text TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          version INTEGER NOT NULL,
          immutable INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'APPROVED',
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS webhook_events (
          event_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          actor_account_id TEXT,
          provider_event_id TEXT,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${this.now()}');
      `);
    }
    if (!applied.includes(2)) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS evaluation_examples (
          example_id TEXT PRIMARY KEY,
          receipt_id TEXT NOT NULL UNIQUE,
          platform TEXT NOT NULL,
          action TEXT NOT NULL,
          actor_account_id TEXT,
          target_account_id TEXT,
          comment_text TEXT NOT NULL,
          context_fingerprint TEXT,
          evidence_json TEXT NOT NULL,
          provider_readback_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          immutable INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS evaluation_examples_platform_idx ON evaluation_examples (platform, created_at);
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, '${this.now()}');
      `);
    }
  }

  backupLegacyFiles() {
    const backupDir = path.join(this.dataDir, 'backups');
    ensureDirectory(backupDir);
    const stamp = timestampForFilename(this.now());
    for (const source of [this.legacyStatePath, this.legacyLedgerPath]) {
      if (!fs.existsSync(source)) continue;
      const destination = path.join(backupDir, `${path.basename(source)}.pre-sqlite-${stamp}.bak`);
      fs.copyFileSync(source, destination);
      this.migration.backups.push(destination);
    }
  }

  importLegacyState(defaultState) {
    const row = this.db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    if (row) return;
    let state = defaultState;
    if (fs.existsSync(this.legacyStatePath)) {
      try {
        state = JSON.parse(fs.readFileSync(this.legacyStatePath, 'utf8'));
        this.migration.importedState = true;
      } catch (error) {
        state = defaultState;
      }
    }
    this.saveState(state);
  }

  importLegacyLedger() {
    if (!fs.existsSync(this.legacyLedgerPath)) return;
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM ledger_events').get();
    if (Number(existing?.count || 0) > 0) return;
    const rows = [];
    for (const line of fs.readFileSync(this.legacyLedgerPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        this.migration.malformedLedgerLines += 1;
      }
    }
    for (const row of rows) {
      this.appendReceipt(row);
      this.migration.importedLedgerRows += 1;
    }
  }

  loadState(defaultState = {}) {
    this.assertOpen();
    const row = this.db.prepare('SELECT state_json FROM app_state WHERE id = 1').get();
    return row ? safeJson(row.state_json, defaultState) : defaultState;
  }

  saveState(state) {
    this.assertOpen();
    const schemaName = String(state?.schema || 'social-engagement-studio-state/v1');
    this.db.prepare(`
      INSERT INTO app_state(id, schema_name, state_json, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET schema_name = excluded.schema_name, state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(schemaName, json(state, {}), this.now());
  }

  setSecret(secretRef, cipherText) {
    this.assertOpen();
    if (!String(secretRef || '').trim()) throw new Error('Secret reference is required');
    if (!String(cipherText || '').trim()) throw new Error('Ciphertext is required');
    this.db.prepare(`
      INSERT INTO secure_secrets(secret_ref, cipher_text, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(secret_ref) DO UPDATE SET cipher_text = excluded.cipher_text, updated_at = excluded.updated_at
    `).run(String(secretRef), String(cipherText), this.now());
  }

  getSecret(secretRef) {
    this.assertOpen();
    const row = this.db.prepare('SELECT cipher_text FROM secure_secrets WHERE secret_ref = ?').get(String(secretRef || ''));
    return row?.cipher_text || null;
  }

  deleteSecret(secretRef) {
    this.assertOpen();
    this.db.prepare('DELETE FROM secure_secrets WHERE secret_ref = ?').run(String(secretRef || ''));
  }

  registerAccount(input) {
    this.assertOpen();
    const account = {
      accountId: String(input?.accountId || '').trim(),
      platform: String(input?.platform || '').trim().toLowerCase(),
      providerAccountId: String(input?.providerAccountId || '').trim(),
      displayName: String(input?.displayName || '').trim().slice(0, 240),
      credentialRef: String(input?.credentialRef || '').trim().slice(0, 240),
      capabilities: input?.capabilities && typeof input.capabilities === 'object' ? input.capabilities : {},
      policy: input?.policy && typeof input.policy === 'object' ? input.policy : {},
      status: String(input?.status || 'connected').trim().toLowerCase(),
      statusReason: input?.statusReason ? String(input.statusReason).trim().slice(0, 160) : null,
    };
    if (!account.accountId || !account.platform || !account.providerAccountId) throw new Error('account_id_platform_and_provider_id_required');
    const current = this.db.prepare('SELECT * FROM actor_accounts WHERE account_id = ?').get(account.accountId);
    const sameProvider = this.db.prepare('SELECT account_id FROM actor_accounts WHERE platform = ? AND provider_account_id = ?').get(account.platform, account.providerAccountId);
    if (current && (current.platform !== account.platform || current.provider_account_id !== account.providerAccountId)) throw new Error('account_provider_identity_immutable');
    if (sameProvider && sameProvider.account_id !== account.accountId) throw new Error('account_provider_identity_conflict');
    const createdAt = current?.created_at || this.now();
    this.db.prepare(`
      INSERT INTO actor_accounts(account_id, platform, provider_account_id, display_name, credential_ref, capabilities_json, policy_json, status, status_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET display_name = excluded.display_name, credential_ref = excluded.credential_ref,
        capabilities_json = excluded.capabilities_json, policy_json = excluded.policy_json, status = excluded.status,
        status_reason = excluded.status_reason, updated_at = excluded.updated_at
    `).run(account.accountId, account.platform, account.providerAccountId, account.displayName, account.credentialRef, json(account.capabilities), json(account.policy), account.status, account.statusReason, createdAt, this.now());
    return this.getAccount(account.accountId);
  }

  updateAccountStatus(accountId, status, statusReason = null) {
    this.assertOpen();
    this.db.prepare('UPDATE actor_accounts SET status = ?, status_reason = ?, updated_at = ? WHERE account_id = ?').run(String(status || 'disconnected'), statusReason ? String(statusReason).slice(0, 160) : null, this.now(), String(accountId));
    return this.getAccount(accountId);
  }

  getAccount(accountId) {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM actor_accounts WHERE account_id = ?').get(String(accountId || ''));
    return row ? this.accountRow(row) : null;
  }

  findAccount(platform, providerAccountId) {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM actor_accounts WHERE platform = ? AND provider_account_id = ?').get(String(platform || '').toLowerCase(), String(providerAccountId || ''));
    return row ? this.accountRow(row) : null;
  }

  listAccounts({ platform, includeDisconnected = true } = {}) {
    this.assertOpen();
    const clauses = [];
    const params = [];
    if (platform) { clauses.push('platform = ?'); params.push(String(platform).toLowerCase()); }
    if (!includeDisconnected) clauses.push("status IN ('connected', 'configured')");
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM actor_accounts ${where} ORDER BY platform, display_name, account_id`).all(...params).map((row) => this.accountRow(row));
  }

  accountRow(row) {
    return {
      accountId: row.account_id,
      platform: row.platform,
      providerAccountId: row.provider_account_id,
      displayName: row.display_name,
      credentialRef: row.credential_ref,
      capabilities: safeJson(row.capabilities_json, {}),
      policy: safeJson(row.policy_json, {}),
      status: row.status,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  appendReceipt(receipt) {
    this.assertOpen();
    const eventId = eventIdFor(receipt);
    const payload = receipt || {};
    const status = String(payload.status || 'UNKNOWN');
    const idempotencyKey = payload.idempotencyKey ? String(payload.idempotencyKey) : null;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_events(event_id, idempotency_key, receipt_id, status, created_at, platform, actor_account_id, target_account_id, provider_id, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      idempotencyKey,
      payload.receiptId || null,
      status,
      String(payload.createdAt || this.now()),
      payload.platform || null,
      payload.actorAccountId || null,
      payload.targetAccountId || null,
      payload.providerId || payload.providerReadBack?.[0]?.providerId || null,
      json(payload),
    );
    if (RECONCILIATION_OPEN_STATUSES.has(status) && idempotencyKey) {
      this.db.prepare(`
        INSERT OR IGNORE INTO reconciliation_inbox(idempotency_key, status, reason_code, action_event_id, updated_at)
        VALUES (?, 'OPEN', ?, ?, ?)
      `).run(idempotencyKey, String(payload.error || (status === 'UNKNOWN' ? 'unknown_mutation' : `${status.toLowerCase()}_without_final_state`)).slice(0, 160), eventId, this.now());
    }
    const providerEvidence = payload.providerReadBack || payload.providerEvidence || null;
    const hasEvidence = providerEvidence && (typeof providerEvidence !== 'object' || Object.keys(providerEvidence).length > 0);
    if (result?.changes && RECONCILIATION_FINAL_STATUSES.has(status) && idempotencyKey && hasEvidence) {
      const resolvedAt = String(payload.reconciledAt || payload.createdAt || this.now());
      this.db.prepare(`
        UPDATE reconciliation_inbox SET status = 'RESOLVED', provider_evidence_json = ?, resolved_by = ?, resolved_at = ?, resolution = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'OPEN'
      `).run(
        json(providerEvidence),
        String(payload.resolvedBy || 'provider_reconciliation').slice(0, 160),
        resolvedAt,
        String(payload.resolution || status).slice(0, 160),
        resolvedAt,
        idempotencyKey,
      );
    }
    if (result?.changes && status === 'LIVE_VERIFIED' && payload.receiptId && String(payload.commentText || '').trim() && hasEvidence) {
      const evidence = {
        contextFingerprint: payload.contextFingerprint || null,
        evidenceLocators: Array.isArray(payload.evidenceLocators) ? payload.evidenceLocators : [],
        gateScore: payload.gateScore ?? null,
        gateVerdict: payload.gateVerdict || null,
        applicationCommit: payload.applicationCommit || null,
        verifiedAt: payload.liveVerifiedAt || payload.reconciledAt || payload.createdAt || this.now(),
      };
      this.db.prepare(`
        INSERT OR IGNORE INTO evaluation_examples(example_id, receipt_id, platform, action, actor_account_id, target_account_id, comment_text, context_fingerprint, evidence_json, provider_readback_json, created_at, immutable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        `example-${eventId}`,
        String(payload.receiptId),
        String(payload.platform || ''),
        String(payload.action || 'comment'),
        payload.actorAccountId || null,
        payload.targetAccountId || null,
        String(payload.commentText).trim(),
        payload.contextFingerprint || null,
        json(evidence),
        json(providerEvidence),
        String(payload.liveVerifiedAt || payload.reconciledAt || payload.createdAt || this.now()),
      );
    }
    return { eventId, inserted: Number(result?.changes || 0) > 0 };
  }

  readLedger() {
    this.assertOpen();
    return this.db.prepare('SELECT payload_json FROM ledger_events ORDER BY sequence').all().map((row) => safeJson(row.payload_json, null)).filter(Boolean);
  }

  readLatestReceipt(idempotencyKey) {
    this.assertOpen();
    const row = this.db.prepare('SELECT payload_json FROM ledger_events WHERE idempotency_key = ? ORDER BY sequence DESC LIMIT 1').get(String(idempotencyKey || ''));
    return row ? safeJson(row.payload_json, null) : null;
  }

  listReconciliation({ unresolvedOnly = true } = {}) {
    this.assertOpen();
    const rows = this.db.prepare(`SELECT * FROM reconciliation_inbox ${unresolvedOnly ? "WHERE status = 'OPEN'" : ''} ORDER BY updated_at DESC`).all();
    return rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      status: row.status,
      reasonCode: row.reason_code,
      actionEventId: row.action_event_id,
      providerEvidence: row.provider_evidence_json ? safeJson(row.provider_evidence_json, null) : null,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
      updatedAt: row.updated_at,
    }));
  }

  resolveReconciliation({ idempotencyKey, resolution, resolvedBy, providerEvidence } = {}) {
    this.assertOpen();
    if (!String(idempotencyKey || '').trim()) throw new Error('reconciliation_idempotency_key_required');
    if (!['LIVE_VERIFIED', 'FAILED'].includes(String(resolution || ''))) throw new Error('reconciliation_resolution_invalid');
    if (!resolvedBy || !providerEvidence || (typeof providerEvidence === 'object' && !Object.keys(providerEvidence).length)) throw new Error('reconciliation_provider_evidence_required');
    const current = this.db.prepare("SELECT * FROM reconciliation_inbox WHERE idempotency_key = ? AND status = 'OPEN'").get(String(idempotencyKey));
    if (!current) throw new Error('reconciliation_item_not_open');
    const resolvedAt = this.now();
    this.db.prepare(`
      UPDATE reconciliation_inbox SET status = 'RESOLVED', provider_evidence_json = ?, resolved_by = ?, resolved_at = ?, resolution = ?, updated_at = ?
      WHERE idempotency_key = ?
    `).run(json(providerEvidence), String(resolvedBy).slice(0, 160), resolvedAt, String(resolution), resolvedAt, String(idempotencyKey));
    return this.listReconciliation({ unresolvedOnly: false }).find((row) => row.idempotencyKey === String(idempotencyKey));
  }

  countActorActions({ actorAccountId, platform, since } = {}) {
    this.assertOpen();
    const sinceIso = since || new Date(Date.now() - 86400000).toISOString();
    const rows = this.db.prepare(`SELECT status FROM ledger_events WHERE actor_account_id = ? AND platform = ? AND created_at >= ?`).all(String(actorAccountId || ''), String(platform || '').toLowerCase(), sinceIso);
    return rows.filter((row) => LIVE_COUNTED_STATUSES.has(String(row.status))).length;
  }

  saveMetricSnapshot(snapshot) {
    this.assertOpen();
    const value = snapshot?.value;
    const snapshotId = String(snapshot?.snapshotId || crypto.randomUUID());
    this.db.prepare(`
      INSERT OR REPLACE INTO metric_snapshots(snapshot_id, platform, actor_account_id, target_account_id, action_id, metric_name, value_json, source, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(snapshotId, String(snapshot.platform || ''), snapshot.actorAccountId || null, snapshot.targetAccountId || null, snapshot.actionId || null, String(snapshot.metricName || ''), json(value), String(snapshot.source || ''), String(snapshot.observedAt || this.now()));
    return this.listMetricSnapshots({ snapshotId })[0];
  }

  listMetricSnapshots({ platform, targetAccountId, snapshotId, limit = 100 } = {}) {
    this.assertOpen();
    const clauses = [];
    const params = [];
    if (platform) { clauses.push('platform = ?'); params.push(String(platform)); }
    if (targetAccountId) { clauses.push('target_account_id = ?'); params.push(String(targetAccountId)); }
    if (snapshotId) { clauses.push('snapshot_id = ?'); params.push(String(snapshotId)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.db.prepare(`SELECT * FROM metric_snapshots ${where} ORDER BY observed_at DESC LIMIT ?`).all(...params, boundedLimit).map((row) => ({
      snapshotId: row.snapshot_id,
      platform: row.platform,
      actorAccountId: row.actor_account_id,
      targetAccountId: row.target_account_id,
      actionId: row.action_id,
      metricName: row.metric_name,
      value: safeJson(row.value_json, null),
      source: row.source,
      observedAt: row.observed_at,
    }));
  }

  pinExemplar(exemplar) {
    this.assertOpen();
    const item = {
      exemplarId: String(exemplar?.exemplarId || '').trim(),
      platform: String(exemplar?.platform || '').trim().toLowerCase(),
      action: String(exemplar?.action || 'comment').trim().toLowerCase(),
      text: String(exemplar?.text || '').trim(),
      evidence: Array.isArray(exemplar?.evidence) ? exemplar.evidence : [],
      sourceHash: String(exemplar?.sourceHash || '').trim(),
      version: Number(exemplar?.version || 1),
      status: 'APPROVED',
    };
    if (!item.exemplarId || !item.platform || !item.text || !item.sourceHash) throw new Error('immutable_exemplar_fields_required');
    const current = this.db.prepare('SELECT text, source_hash FROM exemplars WHERE exemplar_id = ?').get(item.exemplarId);
    if (current && (current.text !== item.text || current.source_hash !== item.sourceHash)) throw new Error('immutable_exemplar_cannot_change');
    this.db.prepare(`
      INSERT OR IGNORE INTO exemplars(exemplar_id, platform, action, text, evidence_json, source_hash, version, immutable, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'APPROVED', ?)
    `).run(item.exemplarId, item.platform, item.action, item.text, json(item.evidence, []), item.sourceHash, item.version, this.now());
    return this.listExemplars({ exemplarId: item.exemplarId })[0];
  }

  listExemplars({ platform, exemplarId } = {}) {
    this.assertOpen();
    const clauses = [];
    const params = [];
    if (platform) { clauses.push('platform = ?'); params.push(String(platform).toLowerCase()); }
    if (exemplarId) { clauses.push('exemplar_id = ?'); params.push(String(exemplarId)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM exemplars ${where} ORDER BY platform, version, created_at`).all(...params).map((row) => ({
      exemplarId: row.exemplar_id,
      platform: row.platform,
      action: row.action,
      text: row.text,
      evidence: safeJson(row.evidence_json, []),
      sourceHash: row.source_hash,
      version: row.version,
      immutable: Boolean(row.immutable),
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  listEvaluationExamples({ platform, actorAccountId, limit = 100 } = {}) {
    this.assertOpen();
    const clauses = [];
    const params = [];
    if (platform) { clauses.push('platform = ?'); params.push(String(platform).toLowerCase()); }
    if (actorAccountId) { clauses.push('actor_account_id = ?'); params.push(String(actorAccountId)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(`SELECT * FROM evaluation_examples ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, boundedLimit).map((row) => ({
      exampleId: row.example_id,
      receiptId: row.receipt_id,
      platform: row.platform,
      action: row.action,
      actorAccountId: row.actor_account_id,
      targetAccountId: row.target_account_id,
      commentText: row.comment_text,
      contextFingerprint: row.context_fingerprint,
      evidence: safeJson(row.evidence_json, {}),
      providerReadBack: safeJson(row.provider_readback_json, null),
      createdAt: row.created_at,
      immutable: Boolean(row.immutable),
    }));
  }

  recordWebhookEvent(event) {
    this.assertOpen();
    const eventId = String(event?.eventId || crypto.randomUUID());
    this.db.prepare(`
      INSERT OR IGNORE INTO webhook_events(event_id, platform, actor_account_id, provider_event_id, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, String(event?.platform || ''), event.actorAccountId || null, event.providerEventId || null, json(event.payload, {}), String(event.receivedAt || this.now()));
    return eventId;
  }

  listWebhookEvents({ platform, limit = 50 } = {}) {
    this.assertOpen();
    if (platform) return this.db.prepare('SELECT * FROM webhook_events WHERE platform = ? ORDER BY received_at DESC LIMIT ?').all(String(platform), Math.max(1, Number(limit) || 50)).map((row) => this.webhookRow(row));
    return this.db.prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?').all(Math.max(1, Number(limit) || 50)).map((row) => this.webhookRow(row));
  }

  webhookRow(row) {
    return { eventId: row.event_id, platform: row.platform, actorAccountId: row.actor_account_id, providerEventId: row.provider_event_id, payload: safeJson(row.payload_json, {}), receivedAt: row.received_at };
  }

  backupDatabase(destination) {
    this.assertOpen();
    ensureDirectory(path.dirname(destination));
    fs.copyFileSync(this.dbPath, destination);
    return destination;
  }

  status() {
    this.assertOpen();
    return {
      mode: 'sqlite',
      dbPath: this.dbPath,
      schemaVersion: ACTIVE_SCHEMA_VERSION,
      migration: { ...this.migration },
      recovery: this.recovery,
      accountCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM actor_accounts').get()?.count || 0),
      unresolvedCount: Number(this.db.prepare("SELECT COUNT(*) AS count FROM reconciliation_inbox WHERE status = 'OPEN'").get()?.count || 0),
      evaluationExampleCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM evaluation_examples').get()?.count || 0),
    };
  }
}

module.exports = { ACTIVE_SCHEMA_VERSION, StudioStorage, eventIdFor };

const { app, BrowserWindow, ipcMain, safeStorage, session, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_CONTEXT,
  DEFAULT_PROFILE,
  PLATFORM_CAPABILITIES,
  capabilityFor,
  chatWithProvider,
  defaultState,
  evaluateCandidate,
  idempotencyKey,
  latestLedgerRows,
  parseLedgerLines,
  runAnalysis,
  rankDiscoveryTarget,
  rankDiscoveryTargets,
  simulationReceipt,
  assessExecutionPolicy,
  sha256,
} = require('./core/engine.cjs');
const { discoverVideos, fetchContext, executeComment } = require('./core/youtube.cjs');

let mainWindow;
let state;
let stateFile;
let ledgerFile;

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function readLedger() {
  try {
    return parseLedgerLines(fs.readFileSync(ledgerFile, 'utf8')).rows;
  } catch (error) {
    return [];
  }
}

function appendLedger(receipt) {
  fs.appendFileSync(ledgerFile, `${JSON.stringify(receipt)}\n`, 'utf8');
}

function encryptSecret(value) {
  if (!value) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is not available; secret was not saved');
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value) {
  if (!value) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch (error) {
    return '';
  }
}

function publicState() {
  const { apiKeyCipher: _providerSecret, ...providerWithoutSecret } = state.provider || {};
  return {
    ...state,
    provider: { ...providerWithoutSecret, apiKeyConfigured: Boolean(state.provider.apiKeyCipher) },
    youtube: {
      apiKeyConfigured: Boolean(state.youtube?.apiKeyCipher),
      accessTokenConfigured: Boolean(state.youtube?.accessTokenCipher),
    },
  };
}

function contextPayloadFingerprint(context) {
  return sha256(JSON.stringify({
    platform: String(context?.platform || ''),
    url: String(context?.url || ''),
    videoId: String(context?.videoId || ''),
    channelId: String(context?.channelId || ''),
    account: String(context?.account || ''),
    publishedAt: String(context?.publishedAt || ''),
    title: String(context?.title || ''),
    description: String(context?.description || ''),
    transcript: String(context?.transcript || ''),
    visualNotes: String(context?.visualNotes || ''),
    comments: (context?.comments || []).map((comment) => typeof comment === 'string' ? comment : { id: comment.id || '', text: comment.text || '' }),
    discoveryRanking: context?.discoveryRanking || null,
  }));
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
}

function trustedAction(input) {
  const analysis = state.lastAnalysis;
  const stored = analysis?.candidates?.find((candidate) => candidate.id === input?.candidate?.id);
  if (!analysis?.pack || !stored) throw new Error('Run analysis again before attempting an action');
  if (stored.text !== input.candidate.text) throw new Error('Candidate changed after analysis; run the gates again');
  if (input?.pack?.contextFingerprint !== analysis.pack.contextFingerprint) throw new Error('Context changed after analysis; run the gates again');
  const liveHistory = readLedger().filter((row) => row.status === 'LIVE_VERIFIED');
  const gate = evaluateCandidate(stored, analysis.pack, state.profile, liveHistory);
  if (gate.verdict !== 'PASS') throw new Error(`Fresh action-bound gate blocked: ${gate.blocked.join(', ')}`);
  return { candidate: { ...stored, gate }, pack: analysis.pack };
}

function configuredProvider() {
  return { ...state.provider, apiKey: decryptSecret(state.provider.apiKeyCipher) };
}

async function executeYouTubeAction(candidate, pack) {
  if (state.provider.kind === 'demo') throw new Error('Live writes require a configured LLM route; the deterministic demo is simulation-only');
  if (pack.source.platform !== 'youtube') throw new Error('The YouTube adapter cannot execute a non-YouTube target');
  const capability = capabilityFor({ platform: 'youtube', action: 'comment', targetScope: pack.source.targetScope || 'external' });
  if (!capability.allowed) throw new Error(`YouTube comment route blocked: ${capability.reason}`);
  const targetUrl = pack.source.url;
  const key = idempotencyKey({ platform: 'youtube', targetUrl, text: candidate.text });
  const policy = assessExecutionPolicy({
    ledger: readLedger(),
    execution: state.execution,
    action: {
      idempotencyKey: key,
      targetUrl,
      targetAccount: pack.source.account,
      targetAccountId: pack.source.channelId,
      gateScore: candidate.gate.score,
      contextSources: pack.source.contextSources,
      criticStatus: candidate.modelCritic?.status || candidate.gate.metrics.modelCritic?.status || 'NOT_PERFORMED',
    },
  });
  if (policy.status !== 'PASS') throw new Error(`Execution policy blocked: ${policy.reasons.join(', ')}`);
  const accessToken = decryptSecret(state.youtube?.accessTokenCipher);
  if (!accessToken) throw new Error('YouTube OAuth access token is not configured');
  const baseReceipt = {
    schema: 'social-engagement-receipt/v1',
    receiptId: `yt-${key.slice(0, 16)}`,
    createdAt: new Date().toISOString(),
    mode: 'live',
    platform: 'youtube',
    targetUrl,
    targetAccount: pack.source.account,
    targetAccountId: pack.source.channelId,
    targetRanking: pack.source.discoveryRanking || null,
    action: 'comment',
    commentText: candidate.text,
    commentSha256: sha256(candidate.text),
    idempotencyKey: key,
    contextFingerprint: pack.contextFingerprint,
    evidenceLocators: candidate.gate.metrics.evidenceLocators,
    gateScore: candidate.gate.score,
    gateVerdict: candidate.gate.verdict,
    gateBlocked: candidate.gate.blocked,
    criticVerdict: candidate.modelCritic || candidate.gate.metrics.modelCritic || { status: 'NOT_PERFORMED' },
  };
  appendLedger({ ...baseReceipt, status: 'DISPATCHED', providerReadBack: null });
  try {
    const commentReadBack = await executeComment({ videoId: pack.source.videoId, channelId: pack.source.channelId, text: candidate.text, accessToken });
    const verified = { ...baseReceipt, createdAt: new Date().toISOString(), status: 'LIVE_VERIFIED', providerReadBack: [{ action: 'comment', ...commentReadBack }] };
    appendLedger(verified);
    return verified;
  } catch (error) {
    const status = error.mutationMayHaveOccurred ? 'UNKNOWN' : 'FAILED';
    appendLedger({ ...baseReceipt, createdAt: new Date().toISOString(), status, providerReadBack: null, error: String(error.message || error).slice(0, 500) });
    const wrapped = new Error(status === 'UNKNOWN' ? 'YouTube may have accepted the comment, but exact read-back failed. The action is held for reconciliation and will not be retried automatically.' : error.message);
    wrapped.executionStatus = status;
    throw wrapped;
  }
}

function assertSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 760,
    minHeight: 720,
    backgroundColor: '#edf1f1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerHandlers() {
  ipcMain.handle('state:load', (event) => {
    assertSender(event);
    return publicState();
  });
  ipcMain.handle('state:save-profile', (event, profile) => {
    assertSender(event);
    const list = (value, fallback) => Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100) : fallback;
    state.profile = {
      ...DEFAULT_PROFILE,
      ...profile,
      language: String(profile.language || DEFAULT_PROFILE.language).trim().slice(0, 16),
      nicheTerms: list(profile.nicheTerms, state.profile.nicheTerms),
      audienceNeeds: list(profile.audienceNeeds, state.profile.audienceNeeds),
      ownedChannelIds: list(profile.ownedChannelIds, state.profile.ownedChannelIds || []),
      allowedChannelIds: list(profile.allowedChannelIds, state.profile.allowedChannelIds || []),
      excludedChannelIds: list(profile.excludedChannelIds, state.profile.excludedChannelIds || []),
      excludedKeywords: list(profile.excludedKeywords, state.profile.excludedKeywords || []),
    };
    writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('state:save-execution', (event, execution) => {
    assertSender(event);
    execution = execution || {};
    state.execution = {
      ...state.execution,
      autonomyEnabled: execution.autonomyEnabled === undefined ? state.execution.autonomyEnabled : Boolean(execution.autonomyEnabled),
      liveWritesEnabled: execution.liveWritesEnabled === undefined ? state.execution.liveWritesEnabled : Boolean(execution.liveWritesEnabled),
      paused: execution.paused === undefined ? state.execution.paused : Boolean(execution.paused),
      maxCommentsPerRun: clampNumber(execution.maxCommentsPerRun, state.execution.maxCommentsPerRun, 1, 10),
      maxCommentsPer24Hours: clampNumber(execution.maxCommentsPer24Hours, state.execution.maxCommentsPer24Hours, 1, 50),
      discoveryLookbackDays: clampNumber(execution.discoveryLookbackDays, state.execution.discoveryLookbackDays, 1, 30),
      targetCooldownHours: clampNumber(execution.targetCooldownHours, state.execution.targetCooldownHours, 1, 2160),
      accountCooldownHours: clampNumber(execution.accountCooldownHours, state.execution.accountCooldownHours, 1, 720),
      minimumGateScore: clampNumber(execution.minimumGateScore, state.execution.minimumGateScore, 60, 100),
    };
    writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('provider:save', (event, provider) => {
    assertSender(event);
    const safeProvider = {
      kind: provider.kind === 'openai-compatible' ? 'openai-compatible' : 'demo',
      name: String(provider.name || '').trim().slice(0, 80),
      model: String(provider.model || '').trim().slice(0, 160),
      criticModel: String(provider.criticModel || '').trim().slice(0, 160),
      baseUrl: String(provider.baseUrl || '').trim().replace(/\/$/, ''),
      apiKeyCipher: provider.apiKey ? encryptSecret(String(provider.apiKey)) : state.provider.apiKeyCipher || null,
    };
    state.provider = safeProvider;
    writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('youtube:save-secrets', (event, secrets) => {
    assertSender(event);
    state.youtube = {
      apiKeyCipher: secrets.apiKey ? encryptSecret(String(secrets.apiKey)) : state.youtube?.apiKeyCipher || null,
      accessTokenCipher: secrets.accessToken ? encryptSecret(String(secrets.accessToken)) : state.youtube?.accessTokenCipher || null,
    };
    writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('youtube:fetch-context', async (event, input) => {
    assertSender(event);
    const apiKey = decryptSecret(state.youtube?.apiKeyCipher);
    const accessToken = decryptSecret(state.youtube?.accessTokenCipher);
    const context = await fetchContext({ url: String(input?.url || ''), apiKey, accessToken });
    state.context = context;
    writeJson(stateFile, state);
    return { context, state: publicState() };
  });
  ipcMain.handle('analysis:run', async (event, context) => {
    assertSender(event);
    const provider = configuredProvider();
    const incoming = context || state.context || DEFAULT_CONTEXT;
    const previous = state.context || DEFAULT_CONTEXT;
    const samePayload = contextPayloadFingerprint(incoming) === contextPayloadFingerprint(previous);
    const sameUrl = String(incoming.url || '') === String(previous.url || '');
    state.context = {
      ...incoming,
      videoId: sameUrl ? String(incoming.videoId || previous.videoId || '') : '',
      channelId: sameUrl ? String(incoming.channelId || previous.channelId || '') : '',
      contextSources: samePayload ? (previous.contextSources || ['manual_context_form']) : ['manual_context_form'],
      discoveryRanking: samePayload ? (previous.discoveryRanking || incoming.discoveryRanking || null) : null,
    };
    const result = await runAnalysis({ context: state.context, profile: state.profile, provider, history: readLedger() });
    state.lastAnalysis = result;
    writeJson(stateFile, state);
    return result;
  });
  ipcMain.handle('llm:chat', async (event, input) => {
    assertSender(event);
    const provider = configuredProvider();
    return chatWithProvider({ message: input?.message, context: state.context || DEFAULT_CONTEXT, profile: state.profile, provider });
  });
  ipcMain.handle('execution:simulate', (event, input) => {
    assertSender(event);
    if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
    const { candidate, pack } = trustedAction(input);
    const receipt = simulationReceipt({ platform: pack.source.platform, targetUrl: pack.source.url, candidate, pack });
    appendLedger(receipt);
    return receipt;
  });
  ipcMain.handle('execution:youtube', async (event, input) => {
    assertSender(event);
    if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
    if (!state.execution.autonomyEnabled || !state.execution.liveWritesEnabled) throw new Error('Live writes are not armed in Settings');
    const { candidate, pack } = trustedAction(input);
    try {
      return await executeYouTubeAction(candidate, pack);
    } catch (error) {
      if (error.executionStatus === 'UNKNOWN') {
        state.execution.paused = true;
        writeJson(stateFile, state);
      }
      throw error;
    }
  });
  ipcMain.handle('execution:youtube-cycle', async (event, input) => {
    assertSender(event);
    if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
    if (!state.execution.autonomyEnabled) throw new Error('Enable bounded auto-run before starting a niche cycle');
    const apiKey = decryptSecret(state.youtube?.apiKeyCipher);
    const accessToken = decryptSecret(state.youtube?.accessTokenCipher);
    if (!apiKey) throw new Error('YouTube Data API key is required for niche discovery');
    if (state.execution.liveWritesEnabled && !accessToken) throw new Error('YouTube OAuth access token is required while live writes are armed');
    const fallbackQuery = (state.profile.nicheTerms || []).slice(0, 4).join('|');
    const query = String(input?.query || fallbackQuery).trim().slice(0, 240);
    const lookbackMs = Number(state.execution.discoveryLookbackDays || 7) * 86400000;
    const discoveredTargets = await discoverVideos({
      query,
      apiKey,
      maxResults: Math.min(25, Number(state.execution.maxCommentsPerRun || 3) * 4),
      publishedAfter: new Date(Date.now() - lookbackMs).toISOString(),
    });
    const targets = rankDiscoveryTargets({ targets: discoveredTargets, profile: state.profile, history: readLedger(), lookbackDays: state.execution.discoveryLookbackDays });
    const results = [];
    let completedActions = 0;
    for (const target of targets) {
      if (completedActions >= Number(state.execution.maxCommentsPerRun || 3)) break;
      if (!target.ranking.eligible) {
        results.push({ targetUrl: target.url, targetAccount: target.account, status: 'FILTERED_BY_RANKING', reason: target.ranking.exclusionReason, targetRanking: target.ranking });
        continue;
      }
      try {
        const context = await fetchContext({ url: target.url, apiKey, accessToken });
        context.discoveryRanking = rankDiscoveryTarget({ target, context, profile: state.profile, history: readLedger(), lookbackDays: state.execution.discoveryLookbackDays });
        const analysis = await runAnalysis({ context, profile: state.profile, provider: configuredProvider(), history: readLedger().filter((row) => row.status === 'LIVE_VERIFIED') });
        const selected = analysis.candidates.find((candidate) => candidate.id === analysis.selectedId);
        if (!selected) {
          results.push({ targetUrl: target.url, targetAccount: target.account, status: 'BLOCKED_BY_GATES', targetRanking: analysis.pack.source.discoveryRanking, reasons: analysis.candidates.flatMap((candidate) => candidate.gate.blocked).slice(0, 8) });
          continue;
        }
        const receipt = state.execution.liveWritesEnabled
          ? await executeYouTubeAction(selected, analysis.pack)
          : simulationReceipt({ platform: 'youtube', targetUrl: analysis.pack.source.url, candidate: selected, pack: analysis.pack });
        if (!state.execution.liveWritesEnabled) appendLedger(receipt);
        completedActions += 1;
        state.context = context;
        state.lastAnalysis = analysis;
        results.push({ targetUrl: target.url, targetAccount: target.account, status: receipt.status, receiptId: receipt.receiptId, targetRanking: analysis.pack.source.discoveryRanking });
      } catch (error) {
        results.push({ targetUrl: target.url, targetAccount: target.account, status: error.executionStatus || 'SKIPPED', reason: String(error.message || error).slice(0, 300) });
        if (error.executionStatus === 'UNKNOWN') {
          state.execution.paused = true;
          break;
        }
      }
    }
    writeJson(stateFile, state);
    return { query, discovered: discoveredTargets.length, ranked: targets.length, completedActions, results, lastAnalysis: state.lastAnalysis || null, state: publicState() };
  });
  ipcMain.handle('ledger:list', (event) => {
    assertSender(event);
    return latestLedgerRows(readLedger()).slice(-50).reverse();
  });
  ipcMain.handle('capabilities:list', (event) => {
    assertSender(event);
    return PLATFORM_CAPABILITIES;
  });
}

app.whenReady().then(() => {
  stateFile = path.join(app.getPath('userData'), 'state.json');
  ledgerFile = path.join(app.getPath('userData'), 'engagement-ledger.jsonl');
  state = readJson(stateFile, defaultState());
  state.profile = { ...DEFAULT_PROFILE, ...(state.profile || {}) };
  state.context = state.context || DEFAULT_CONTEXT;
  state.execution = { ...defaultState().execution, ...(state.execution || {}) };
  state.provider = { kind: 'demo', name: 'Local demo', model: 'deterministic-demo', criticModel: '', baseUrl: '', ...(state.provider || {}) };
  registerHandlers();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

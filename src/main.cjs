const { app, BrowserWindow, ipcMain, safeStorage, session, Menu, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { BUILD_METADATA } = require('./core/build-metadata.cjs');
const {
  DEFAULT_PROFILE,
  RUNTIME_DEFAULT_CONTEXT,
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
const {
  AutomationRunner,
  defaultAutomationRuntime,
  normalizeAutomationExecution,
  normalizeIntervalMinutes,
  normalizePlatforms,
} = require('./core/automation-runner.cjs');
const { discoverVideos, fetchContext, executeComment, executeReply, fetchAuthorizedChannel, reconcileYouTubeComment } = require('./core/youtube.cjs');
const { StudioStorage } = require('./core/storage.cjs');
const { META_API_VERSION, DEFAULT_META_APP_ID, META_PERMISSIONS, authorizeMetaDesktop, fetchManagedAccounts } = require('./core/meta-auth.cjs');
const { createInstagramContext, createFacebookContext, executeInstagramAction, executeFacebookAction, reconcileMetaAction, listInstagramMedia, listFacebookMedia } = require('./core/meta.cjs');
const { inspectAuthorizedMedia } = require('./core/media-understanding.cjs');
const {
  YOUTUBE_COMMENT_SCOPE,
  DEFAULT_YOUTUBE_OAUTH_CLIENT_ID,
  authorizeDesktop,
  refreshAccessToken,
  revokeToken,
  isAccessTokenUsable,
} = require('./core/youtube-auth.cjs');

let mainWindow;
let state;
let stateFile;
let ledgerFile;
let storage;
let automationRunner;
let cycleInFlight = null;

function ensureMetaState() {
  state.meta = {
    appId: DEFAULT_META_APP_ID,
    appSecretCipher: null,
    graphApiVersion: META_API_VERSION,
    status: 'disconnected',
    statusReason: null,
    permissions: [],
    lastConnectedAt: null,
    ...state.meta,
  };
  if (!String(state.meta.appId || '').trim()) state.meta.appId = DEFAULT_META_APP_ID;
  state.meta.graphApiVersion = /^v\d+\.\d+$/.test(String(state.meta.graphApiVersion || '')) ? String(state.meta.graphApiVersion) : META_API_VERSION;
  state.meta.permissions = Array.isArray(state.meta.permissions) ? state.meta.permissions.map((permission) => String(permission || '').trim()).filter(Boolean) : [];
  return state.meta;
}

function ensureAutomationState() {
  state.automation = {
    ...defaultAutomationRuntime(),
    ...(state.automation || {}),
  };
  if (!Array.isArray(state.automation.lastRun?.platforms)) state.automation.lastRun = null;
  return state.automation;
}

function isSyntheticContext(context) {
  const sources = Array.isArray(context?.contextSources) ? context.contextSources : [];
  return sources.includes('demo_fixture')
    || String(context?.videoId || '') === 'demo-context'
    || String(context?.channelId || '') === 'demo-channel'
    || String(context?.url || '') === 'https://www.youtube.com/watch?v=demo-context';
}

function writeJson(file, value) {
  if (storage && file === stateFile) {
    storage.saveState(value);
    return;
  }
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  if (storage && file === stateFile) return storage.loadState(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function readLedger() {
  if (storage) return storage.readLedger();
  try {
    return parseLedgerLines(fs.readFileSync(ledgerFile, 'utf8')).rows;
  } catch (error) {
    return [];
  }
}

function appendLedger(receipt) {
  if (storage) {
    storage.appendReceipt(receipt);
    return;
  }
  fs.appendFileSync(ledgerFile, `${JSON.stringify(receipt)}\n`, 'utf8');
}

function recordContextMetrics(context, actorAccountId = null) {
  if (!storage || !context) return;
  const values = {
    views: context.views,
    likes: context.likes,
    commentCount: context.commentCount ?? context.metrics?.commentCount,
    likeCount: context.metrics?.likeCount,
  };
  const source = (context.contextSources || []).find((item) => String(item).includes('videos') || String(item).includes('media') || String(item).includes('feed')) || 'provider_context';
  Object.entries(values).forEach(([metricName, value]) => {
    if (!Number.isFinite(Number(value))) return;
    storage.saveMetricSnapshot({
      platform: context.platform,
      actorAccountId,
      targetAccountId: context.channelId || null,
      actionId: context.targetId || context.videoId || null,
      metricName,
      value: Number(value),
      source,
      observedAt: new Date().toISOString(),
    });
  });
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

function assertLiveBuildMetadata() {
  if (BUILD_METADATA.applicationCommit === 'unknown' || BUILD_METADATA.buildDirty) {
    throw new Error('Live writes require a clean, versioned application build. Package the committed checkout before arming public actions.');
  }
}

function actionReceiptFields({ candidate, actor, policy, budgetMax }) {
  const gate = candidate.gate || {};
  return {
    applicationVersion: BUILD_METADATA.applicationVersion,
    applicationCommit: BUILD_METADATA.applicationCommit,
    buildDirty: BUILD_METADATA.buildDirty,
    actorCredentialRef: actor.credentialRef,
    actorProviderAccountId: actor.providerAccountId,
    budgetDecision: {
      status: policy.status,
      reasons: [...(policy.reasons || [])],
      recentAttempts: policy.recentAttempts,
      actorBudgetMaxPer24Hours: budgetMax,
    },
    gateDecision: {
      verdict: gate.verdict || null,
      score: gate.score || 0,
      blocked: [...(gate.blocked || [])],
      warnings: [...(gate.warnings || [])],
      metrics: gate.metrics || null,
    },
    criticVerdict: candidate.modelCritic || gate.metrics?.modelCritic || { status: 'NOT_PERFORMED' },
  };
}

function ensureYouTubeState() {
  const existing = state.youtube || {};
  state.youtube = {
    apiKeyCipher: null,
    oauthClientId: DEFAULT_YOUTUBE_OAUTH_CLIENT_ID,
    oauthClientSecretCipher: null,
    accessTokenCipher: null,
    refreshTokenCipher: null,
    accessTokenExpiresAt: 0,
    grantedScopes: [],
    oauthStatus: 'disconnected',
    oauthStatusReason: null,
    lastConnectedAt: null,
    lastTokenRefreshAt: null,
    ...existing,
  };
  if (!String(state.youtube.oauthClientId || '').trim()) state.youtube.oauthClientId = DEFAULT_YOUTUBE_OAUTH_CLIENT_ID;
  state.youtube.grantedScopes = Array.isArray(state.youtube.grantedScopes)
    ? state.youtube.grantedScopes.map((scope) => String(scope || '').trim()).filter(Boolean)
    : [];
  if (state.youtube.accessTokenCipher && !state.youtube.refreshTokenCipher) {
    state.youtube.accessTokenCipher = null;
    state.youtube.accessTokenExpiresAt = 0;
    state.youtube.oauthStatus = 'disconnected';
    state.youtube.oauthStatusReason = 'legacy_access_token_removed';
  }
  if (state.youtube.refreshTokenCipher && !existing.oauthStatus) state.youtube.oauthStatus = 'configured';
  return state.youtube;
}

function oauthReason(error) {
  return String(error?.code || 'oauth_error').replace(/[^a-z0-9_]+/gi, '_').slice(0, 80) || 'oauth_error';
}

function youtubeClientSecretRequired(youtube = ensureYouTubeState()) {
  return youtube.oauthClientId === DEFAULT_YOUTUBE_OAUTH_CLIENT_ID;
}

function oauthUserError(error) {
  const code = oauthReason(error);
  const providerDescription = String(error?.providerDescription || '').replace(/[^a-z0-9 .,_:-]+/gi, ' ').trim().slice(0, 180);
  const providerHint = providerDescription ? ` Provider response: ${providerDescription}.` : '';
  const messages = {
    oauth_client_missing: 'YouTube OAuth client ID is not configured.',
    oauth_client_secret_missing: 'This YouTube desktop OAuth client requires its client secret. Enter it once and save the connection settings; it will remain OS-protected.',
    authorization_request_invalid: 'YouTube OAuth could not start because the authorization request is incomplete.',
    access_denied: 'YouTube authorization was declined. You can reconnect when ready.',
    oauth_timeout: 'YouTube authorization timed out. Reconnect to try again.',
    state_mismatch: 'YouTube authorization could not be verified. Reconnect to try again.',
    required_scope_not_granted: 'YouTube did not grant the required comment scope. Reconnect and allow the requested permission.',
    refresh_token_missing: 'YouTube did not return offline access. Reconnect to obtain a refresh token.',
    invalid_grant: 'YouTube authorization was revoked or expired. Reconnect to restore access.',
    invalid_client: 'The YouTube OAuth client configuration was rejected. Check the desktop client ID.',
    unauthorized_client: 'The YouTube OAuth client is not authorized for this desktop flow.',
    invalid_request: `Google rejected the YouTube OAuth token request. Check the desktop client and loopback configuration.${providerHint}`,
    redirect_uri_mismatch: 'Google rejected the loopback redirect. Use a Desktop OAuth client, not a Web client.',
    invalid_scope: 'Google rejected the requested YouTube scope. Check the client and consent configuration.',
    oauth_network_error: 'YouTube authorization could not reach Google. Check the network and try again.',
    oauth_server_error: 'Google temporarily rejected the YouTube authorization request. Try again later.',
    oauth_request_failed: 'YouTube authorization failed. Reconnect to try again.',
    oauth_authorization_failed: 'Google did not complete YouTube authorization. Reconnect to try again.',
    oauth_not_connected: 'YouTube is not connected. Connect the account before enabling live writes.',
    browser_open_failed: 'The system browser could not be opened for YouTube authorization.',
  };
  const safe = new Error(messages[code] || 'YouTube authorization is not connected. Reconnect to try again.');
  safe.code = code;
  return safe;
}

function clearYouTubeOAuthTokens() {
  const youtube = ensureYouTubeState();
  youtube.accessTokenCipher = null;
  youtube.refreshTokenCipher = null;
  youtube.accessTokenExpiresAt = 0;
  youtube.grantedScopes = [];
}

function metaCredentialRef(providerAccountId) {
  return `meta:page:${String(providerAccountId || '').trim()}`;
}

function metaAccountForProviderId(platform, providerAccountId) {
  const account = storage?.findAccount(platform, providerAccountId);
  if (!account || account.status !== 'connected') {
    const error = new Error(`No connected ${platform} actor account is registered for this target.`);
    error.code = 'actor_account_not_connected';
    throw error;
  }
  if (!account.capabilities?.comment && !account.capabilities?.reply) {
    const error = new Error(`The connected ${platform} actor account does not have the required managed-media capability.`);
    error.code = 'actor_capability_missing';
    throw error;
  }
  return account;
}

function decryptAccountToken(account) {
  const cipher = storage?.getSecret(account?.credentialRef);
  const token = decryptSecret(cipher);
  if (!token) {
    storage?.updateAccountStatus(account.accountId, 'disconnected', 'credential_unavailable');
    throw new Error('The connected actor account credential is unavailable. Reconnect the account.');
  }
  return token;
}

async function connectMeta() {
  const meta = ensureMetaState();
  if (!meta.appId) throw new Error('Meta App ID is not configured.');
  const appSecret = decryptSecret(meta.appSecretCipher);
  if (!appSecret) throw new Error('Meta App Secret is not configured.');
  meta.status = 'authorizing';
  meta.statusReason = null;
  writeJson(stateFile, state);
  try {
    const token = await authorizeMetaDesktop({
      appId: meta.appId,
      appSecret,
      apiVersion: meta.graphApiVersion,
      openExternal: (authorizationUrl) => shell.openExternal(authorizationUrl),
    });
    const managed = await fetchManagedAccounts({ accessToken: token.accessToken, apiVersion: meta.graphApiVersion });
    if (!managed.length) throw new Error('Meta did not return any managed Page or linked professional Instagram account.');
    storage.setSecret('meta:user', encryptSecret(token.accessToken));
    for (const item of managed) {
      if (!item.accessToken) continue;
      const credentialRef = metaCredentialRef(item.platform === 'instagram' ? item.pageId : item.providerAccountId);
      storage.setSecret(credentialRef, encryptSecret(item.accessToken));
      storage.registerAccount({
        accountId: `${item.platform}:${item.providerAccountId}`,
        platform: item.platform,
        providerAccountId: item.providerAccountId,
        displayName: item.displayName,
        credentialRef,
        capabilities: item.capabilities,
        policy: { maxActionsPer24Hours: 5, targetCooldownHours: 168 },
        status: 'connected',
        statusReason: null,
      });
    }
    meta.status = 'connected';
    meta.statusReason = null;
    meta.permissions = [...META_PERMISSIONS];
    meta.lastConnectedAt = new Date().toISOString();
    meta.tokenExpiresAt = token.expiresAt;
    meta.dataAccessExpiresAt = token.dataAccessExpiresAt;
    writeJson(stateFile, state);
    return publicState();
  } catch (error) {
    meta.status = 'error';
    const providerDetail = String(error?.providerDescription || '').replace(/[\r\n]+/g, ' ').slice(0, 140);
    meta.statusReason = `${String(error?.code || 'meta_authorization_failed').replace(/[^a-z0-9_]+/gi, '_').slice(0, 60)}${providerDetail ? `: ${providerDetail}` : ''}`.slice(0, 200);
    writeJson(stateFile, state);
    throw new Error('Meta authorization or managed-account discovery failed. Reconnect after checking app review, permissions, and account access.');
  }
}

async function disconnectMeta() {
  const meta = ensureMetaState();
  for (const account of storage.listAccounts({ platform: 'facebook' }).concat(storage.listAccounts({ platform: 'instagram' }))) {
    if (account.credentialRef) storage.deleteSecret(account.credentialRef);
    storage.updateAccountStatus(account.accountId, 'disconnected', 'disconnected_by_operator');
  }
  storage.deleteSecret('meta:user');
  meta.status = 'disconnected';
  meta.statusReason = 'disconnected_by_operator';
  meta.lastConnectedAt = null;
  writeJson(stateFile, state);
  return publicState();
}

function storeYouTubeOAuthTokens(tokens, { refreshed = false } = {}) {
  const youtube = ensureYouTubeState();
  youtube.accessTokenCipher = encryptSecret(tokens.accessToken);
  if (tokens.refreshToken) youtube.refreshTokenCipher = encryptSecret(tokens.refreshToken);
  youtube.accessTokenExpiresAt = Number(tokens.expiresAt) || 0;
  youtube.grantedScopes = Array.isArray(tokens.grantedScopes) ? [...tokens.grantedScopes] : [YOUTUBE_COMMENT_SCOPE];
  youtube.oauthStatus = 'connected';
  youtube.oauthStatusReason = null;
  if (!refreshed) youtube.lastConnectedAt = new Date().toISOString();
  if (refreshed) youtube.lastTokenRefreshAt = new Date().toISOString();
}

function oauthReady() {
  const youtube = ensureYouTubeState();
  const connectedState = ['connected', 'configured'].includes(String(youtube.oauthStatus || ''));
  const registeredActor = storage?.listAccounts({ platform: 'youtube', includeDisconnected: false }).find((account) => account.credentialRef === 'youtube:primary' && account.capabilities?.comment);
  const clientSecretReady = !youtubeClientSecretRequired(youtube) || Boolean(youtube.oauthClientSecretCipher);
  return Boolean(connectedState && registeredActor && youtube.refreshTokenCipher && youtube.oauthClientId && clientSecretReady && youtube.grantedScopes.includes(YOUTUBE_COMMENT_SCOPE));
}

async function ensureYouTubeAccessToken() {
  const youtube = ensureYouTubeState();
  const accessToken = decryptSecret(youtube.accessTokenCipher);
  if (isAccessTokenUsable({ accessToken, expiresAt: youtube.accessTokenExpiresAt })) return accessToken;
  const refreshToken = decryptSecret(youtube.refreshTokenCipher);
  if (!refreshToken || !youtube.oauthClientId) {
    youtube.oauthStatus = 'disconnected';
    youtube.oauthStatusReason = 'oauth_not_connected';
    writeJson(stateFile, state);
    throw oauthUserError({ code: 'oauth_not_connected' });
  }
  try {
    const tokens = await refreshAccessToken({
      clientId: youtube.oauthClientId,
      clientSecret: decryptSecret(youtube.oauthClientSecretCipher),
      refreshToken,
      previousScopes: youtube.grantedScopes,
    });
    storeYouTubeOAuthTokens(tokens, { refreshed: true });
    writeJson(stateFile, state);
    return tokens.accessToken;
  } catch (error) {
    if (['invalid_grant', 'invalid_client', 'unauthorized_client', 'required_scope_not_granted'].includes(error.code)) {
      clearYouTubeOAuthTokens();
      youtube.oauthStatus = 'disconnected';
    } else {
      youtube.oauthStatus = 'error';
    }
    youtube.oauthStatusReason = oauthReason(error);
    writeJson(stateFile, state);
    throw oauthUserError(error);
  }
}

async function connectYouTube() {
  const youtube = ensureYouTubeState();
  if (!youtube.oauthClientId) throw oauthUserError({ code: 'oauth_client_missing' });
  if (youtubeClientSecretRequired(youtube) && !decryptSecret(youtube.oauthClientSecretCipher)) throw oauthUserError({ code: 'oauth_client_secret_missing' });
  youtube.oauthStatus = 'authorizing';
  youtube.oauthStatusReason = null;
  writeJson(stateFile, state);
  try {
    const tokens = await authorizeDesktop({
      clientId: youtube.oauthClientId,
      clientSecret: decryptSecret(youtube.oauthClientSecretCipher),
      openExternal: (authorizationUrl) => shell.openExternal(authorizationUrl),
    });
    storeYouTubeOAuthTokens(tokens);
    const identity = await fetchAuthorizedChannel({ accessToken: tokens.accessToken });
    for (const account of storage.listAccounts({ platform: 'youtube' })) {
      if (account.credentialRef === 'youtube:primary' && account.providerAccountId !== identity.providerAccountId) storage.updateAccountStatus(account.accountId, 'disconnected', 'replaced_by_reconnect');
    }
    storage.registerAccount({
      accountId: `youtube:${identity.providerAccountId}`,
      platform: 'youtube',
      providerAccountId: identity.providerAccountId,
      displayName: identity.displayName,
      credentialRef: 'youtube:primary',
      capabilities: identity.capabilities,
      policy: { maxActionsPer24Hours: Number(state.execution.maxCommentsPer24Hours || 10), targetCooldownHours: Number(state.execution.targetCooldownHours || 168) },
      status: 'connected',
    });
    writeJson(stateFile, state);
    return publicState();
  } catch (error) {
    const safe = oauthUserError(error);
    youtube.oauthStatus = ['access_denied', 'oauth_timeout', 'state_mismatch'].includes(safe.code) ? 'disconnected' : 'error';
    youtube.oauthStatusReason = safe.code;
    writeJson(stateFile, state);
    throw safe;
  }
}

async function disconnectYouTube() {
  const youtube = ensureYouTubeState();
  const token = decryptSecret(youtube.refreshTokenCipher) || decryptSecret(youtube.accessTokenCipher);
  let reason = 'disconnected_by_operator';
  if (token) {
    try {
      await revokeToken({ token });
    } catch (error) {
      reason = 'revocation_unconfirmed';
    }
  }
  clearYouTubeOAuthTokens();
  for (const account of storage.listAccounts({ platform: 'youtube' })) {
    if (account.status === 'connected') storage.updateAccountStatus(account.accountId, 'disconnected', reason);
  }
  youtube.oauthStatus = 'disconnected';
  youtube.oauthStatusReason = reason;
  youtube.lastConnectedAt = null;
  youtube.lastTokenRefreshAt = null;
  writeJson(stateFile, state);
  return publicState();
}

function liveModelRouteReady() {
  return state.provider?.kind === 'openai-compatible'
    && Boolean(String(state.provider.model || '').trim())
    && Boolean(String(state.provider.criticModel || '').trim());
}

function cleanBuildReady() {
  return Boolean(BUILD_METADATA.applicationCommit && BUILD_METADATA.applicationCommit !== 'unknown' && !BUILD_METADATA.buildDirty);
}

function metaActorForAutomation(platform) {
  return storage?.listAccounts({ platform, includeDisconnected: false })
    .find((account) => account.status === 'connected' && account.capabilities?.reply);
}

function hasStoredAccountCredential(account) {
  if (!account?.credentialRef || !storage) return false;
  return Boolean(decryptSecret(storage.getSecret(account.credentialRef)));
}

function platformRuntime() {
  const execution = normalizeAutomationExecution(state.execution || {});
  const providerReady = liveModelRouteReady();
  const buildReady = cleanBuildReady();
  const liveWrites = Boolean(execution.liveWritesEnabled);
  const runtime = {};

  const youtubeActor = storage?.listAccounts({ platform: 'youtube', includeDisconnected: false })
    .find((account) => account.status === 'connected' && account.capabilities?.comment);
  const youtubeConfigured = Boolean(state.youtube?.apiKeyCipher || state.youtube?.refreshTokenCipher);
  const youtubeReasons = [];
  if (!youtubeConfigured) youtubeReasons.push('Connect YouTube or add a YouTube Data API key');
  if (liveWrites && !oauthReady()) youtubeReasons.push('YouTube comment OAuth is not connected');
  if (liveWrites && !youtubeActor) youtubeReasons.push('No connected YouTube actor account is available');
  if (liveWrites && !providerReady) youtubeReasons.push('A generation model and independent critic are required for live writes');
  if (liveWrites && !buildReady) youtubeReasons.push('Live writes require a clean packaged build');
  runtime.youtube = {
    platform: 'youtube',
    label: 'YouTube',
    enabled: execution.enabledPlatforms.includes('youtube'),
    ready: youtubeReasons.length === 0,
    mode: liveWrites ? 'live' : 'simulation',
    reason: youtubeReasons[0] || (liveWrites ? 'Ready for bounded live execution' : 'Ready for bounded simulation'),
    reasons: youtubeReasons,
    actorAccountId: youtubeActor?.accountId || null,
    contextAccess: state.youtube?.refreshTokenCipher ? 'oauth' : state.youtube?.apiKeyCipher ? 'api_key' : 'none',
  };

  for (const platform of ['instagram', 'facebook']) {
    const actor = metaActorForAutomation(platform);
    const reasons = [];
    if (state.meta?.status !== 'connected') reasons.push('Meta is not connected');
    if (!actor) reasons.push(`No connected ${platform} actor account is available`);
    if (actor && !hasStoredAccountCredential(actor)) reasons.push(`The connected ${platform} credential is unavailable`);
    if (liveWrites && !providerReady) reasons.push('A generation model and independent critic are required for live writes');
    if (liveWrites && !buildReady) reasons.push('Live writes require a clean packaged build');
    runtime[platform] = {
      platform,
      label: platform === 'instagram' ? 'Instagram' : 'Facebook',
      enabled: execution.enabledPlatforms.includes(platform),
      ready: reasons.length === 0,
      mode: liveWrites ? 'live' : 'simulation',
      reason: reasons[0] || (liveWrites ? 'Ready for bounded live execution' : 'Ready for bounded simulation'),
      reasons,
      actorAccountId: actor?.accountId || null,
    };
  }
  return runtime;
}

function publicState() {
  const { apiKeyCipher: _providerSecret, ...providerWithoutSecret } = state.provider || {};
  const youtube = ensureYouTubeState();
  ensureAutomationState();
  return {
    ...state,
    buildMetadata: BUILD_METADATA,
    provider: { ...providerWithoutSecret, apiKeyConfigured: Boolean(state.provider.apiKeyCipher) },
    youtube: {
      apiKeyConfigured: Boolean(youtube.apiKeyCipher),
      dataApiReady: Boolean(youtube.apiKeyCipher || youtube.refreshTokenCipher),
      contextAccess: youtube.refreshTokenCipher ? 'oauth' : youtube.apiKeyCipher ? 'api_key' : 'none',
      oauthClientId: youtube.oauthClientId || '',
      oauthClientIdConfigured: Boolean(youtube.oauthClientId),
      oauthClientSecretConfigured: Boolean(youtube.oauthClientSecretCipher),
      oauthClientSecretRequired: youtubeClientSecretRequired(youtube),
      oauthStatus: youtube.oauthStatus,
      oauthStatusReason: youtube.oauthStatusReason,
      oauthReady: oauthReady(),
      requestedScopes: [YOUTUBE_COMMENT_SCOPE],
      grantedScopes: [...youtube.grantedScopes],
      credentialStorage: 'OS protected',
      lastConnectedAt: youtube.lastConnectedAt,
      lastTokenRefreshAt: youtube.lastTokenRefreshAt,
      accessTokenExpiresAt: Number(youtube.accessTokenExpiresAt) || null,
    },
    meta: {
      appId: state.meta?.appId || '',
      appIdConfigured: Boolean(state.meta?.appId),
      appSecretConfigured: Boolean(state.meta?.appSecretCipher),
      graphApiVersion: state.meta?.graphApiVersion || 'v26.0',
      status: state.meta?.status || 'disconnected',
      statusReason: state.meta?.statusReason || null,
      permissions: Array.isArray(state.meta?.permissions) ? [...state.meta.permissions] : [],
      lastConnectedAt: state.meta?.lastConnectedAt || null,
    },
    platformRuntime: platformRuntime(),
    accounts: storage ? storage.listAccounts() : [],
    reconciliationInbox: storage ? storage.listReconciliation() : [],
    metricSnapshots: storage ? storage.listMetricSnapshots({ limit: 60 }) : [],
    exemplars: storage ? storage.listExemplars() : [],
    evaluationExamples: storage ? storage.listEvaluationExamples({ limit: 60 }) : [],
    storage: storage ? storage.status() : null,
  };
}

function publishAutomationState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('automation:state', publicState());
}

function setupAutomationRunner() {
  automationRunner = new AutomationRunner({
    getExecution: () => state.execution,
    getRuntime: () => ensureAutomationState(),
    setRuntime: (runtime) => { state.automation = runtime; },
    persist: () => writeJson(stateFile, state),
    runPlatform: (platform) => runPlatformCycle(platform),
    onState: () => publishAutomationState(),
  });
}

function runPlatformCycle(platform, input = {}) {
  if (cycleInFlight) {
    const error = new Error('Another bounded automation cycle is already running. The next scheduled run will continue after it finishes.');
    error.code = 'cycle_in_progress';
    return Promise.reject(error);
  }
  const task = platform === 'youtube' ? runYouTubeCycle(input) : runMetaCycle(platform);
  const tracked = Promise.resolve(task).finally(() => {
    if (cycleInFlight === tracked) cycleInFlight = null;
  });
  cycleInFlight = tracked;
  return tracked;
}

function syncAutomationRuntime({ runNow = false, reason = 'configuration' } = {}) {
  if (!automationRunner) return;
  state.execution = normalizeAutomationExecution(state.execution || {});
  const execution = state.execution;
  const result = execution.autonomyEnabled && !execution.paused
    ? automationRunner.start({ runNow, reason })
    : automationRunner.stop(execution.paused ? 'kill_switch' : 'autonomy_disabled');
  if (result && typeof result.catch === 'function') {
    result.catch((error) => {
      automationRunner.updateRuntime({
        status: 'ERROR',
        currentPlatform: null,
        currentRunStartedAt: null,
        nextRunAt: null,
        lastError: String(error?.message || error).slice(0, 300),
      });
    });
  }
}

function contextPayloadFingerprint(context) {
  return sha256(JSON.stringify({
    platform: String(context?.platform || ''),
    action: String(context?.action || ''),
    targetScope: String(context?.targetScope || ''),
    url: String(context?.url || ''),
    targetId: String(context?.targetId || ''),
    replyToId: String(context?.replyToId || ''),
    videoId: String(context?.videoId || ''),
    channelId: String(context?.channelId || ''),
    actorAccountId: String(context?.actorAccountId || ''),
    ownershipStatus: String(context?.ownershipStatus || ''),
    account: String(context?.account || ''),
    publishedAt: String(context?.publishedAt || ''),
    title: String(context?.title || ''),
    description: String(context?.description || ''),
    transcript: String(context?.transcript || ''),
    transcriptStatus: String(context?.transcriptStatus || ''),
    visualNotes: String(context?.visualNotes || ''),
    authorizedMediaStatus: String(context?.authorizedMediaStatus || ''),
    mediaProvenance: context?.mediaProvenance || null,
    transcriptProvenance: context?.transcriptProvenance || null,
    visualProvenance: context?.visualProvenance || [],
    transcriptSegments: Array.isArray(context?.transcriptSegments)
      ? context.transcriptSegments.map((segment) => ({
        id: segment?.id || '',
        text: segment?.text || '',
        startMs: segment?.startMs ?? null,
        endMs: segment?.endMs ?? null,
        timestamp: segment?.timestamp || '',
        sourceId: segment?.sourceId || '',
        sourceHash: segment?.sourceHash || '',
      }))
      : [],
    visualObservations: Array.isArray(context?.visualObservations)
      ? context.visualObservations.map((observation) => ({
        timestampMs: observation?.timestampMs ?? null,
        text: observation?.text || observation?.observation || '',
        sourceId: observation?.sourceId || '',
        sourceHash: observation?.sourceHash || '',
      }))
      : [],
    contextSources: Array.isArray(context?.contextSources) ? context.contextSources : [],
    metrics: context?.metrics || null,
    comments: (context?.comments || []).map((comment) => typeof comment === 'string' ? comment : { id: comment.id || '', text: comment.text || '' }),
    discoveryRanking: context?.discoveryRanking || null,
  }));
}

function manualContextOnly(incoming) {
  return {
    ...incoming,
    videoId: '',
    channelId: '',
    actorAccountId: '',
    ownershipStatus: '',
    contextSources: ['manual_context_form'],
    captionStatus: 'manual_context',
    visualStatus: 'manual_context',
    authorizedMediaStatus: 'MANUAL_CONTEXT_ONLY',
    mediaProvenance: null,
    transcriptProvenance: null,
    transcriptStatus: 'manual_context',
    visualProvenance: [],
    transcriptSegments: [],
    visualObservations: [],
    metrics: null,
    discoveryRanking: null,
  };
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
  if (analysis.contextPayloadFingerprint && contextPayloadFingerprint(state.context) !== analysis.contextPayloadFingerprint) throw new Error('The stored context changed after analysis; hydrate or inspect the source again before attempting an action');
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
  const actionName = pack.source.action || 'comment';
  const capability = capabilityFor({ platform: 'youtube', action: actionName, targetScope: pack.source.targetScope || 'external' });
  if (!capability.allowed) throw new Error(`YouTube ${actionName} route blocked: ${capability.reason}`);
  assertLiveBuildMetadata();
  const actor = storage.listAccounts({ platform: 'youtube', includeDisconnected: false }).find((account) => account.credentialRef === 'youtube:primary' && account.capabilities?.[actionName]);
  if (!actor) throw new Error('A connected YouTube actor account is required for live execution.');
  if (pack.source.actorAccountId !== actor.accountId) throw new Error('The analyzed action is not bound to the currently connected YouTube actor account. Hydrate the target again before live execution.');
  const targetUrl = pack.source.url;
  const key = idempotencyKey({ platform: 'youtube', actorAccountId: actor.accountId, targetUrl, text: candidate.text });
  const policy = assessExecutionPolicy({
    ledger: readLedger(),
    execution: state.execution,
    action: {
      platform: 'youtube',
      idempotencyKey: key,
      targetUrl,
      actorAccountId: actor.accountId,
      actorBudgetMaxPer24Hours: Number(actor.policy?.maxActionsPer24Hours || state.execution.maxCommentsPer24Hours || 10),
      requireActorAccount: true,
      targetAccount: pack.source.account,
      targetAccountId: pack.source.channelId,
      gateScore: candidate.gate.score,
      contextSources: pack.source.contextSources,
      criticStatus: candidate.modelCritic?.status || candidate.gate.metrics.modelCritic?.status || 'NOT_PERFORMED',
    },
  });
  if (policy.status !== 'PASS') throw new Error(`Execution policy blocked: ${policy.reasons.join(', ')}`);
  const accessToken = await ensureYouTubeAccessToken();
  const baseReceipt = {
    schema: 'social-engagement-receipt/v1',
    receiptId: `yt-${key.slice(0, 16)}`,
    createdAt: new Date().toISOString(),
    mode: 'live',
    platform: 'youtube',
    targetUrl,
    targetAccount: pack.source.account,
    actorAccountId: actor.accountId,
    targetAccountId: pack.source.channelId,
    targetRanking: pack.source.discoveryRanking || null,
    action: actionName,
    commentText: candidate.text,
    commentSha256: sha256(candidate.text),
    idempotencyKey: key,
    contextFingerprint: pack.contextFingerprint,
    evidenceLocators: candidate.gate.metrics.evidenceLocators,
    gateScore: candidate.gate.score,
    gateVerdict: candidate.gate.verdict,
    gateBlocked: candidate.gate.blocked,
    ...actionReceiptFields({ candidate, actor, policy, budgetMax: Number(actor.policy?.maxActionsPer24Hours || state.execution.maxCommentsPer24Hours || 10) }),
    dispatchedAt: new Date().toISOString(),
  };
  appendLedger({ ...baseReceipt, status: 'DISPATCHED', providerReadBack: null });
  try {
    const commentReadBack = actionName === 'reply'
      ? await executeReply({ parentId: pack.source.replyToId, text: candidate.text, accessToken })
      : await executeComment({ videoId: pack.source.videoId, channelId: pack.source.channelId, text: candidate.text, accessToken });
    const verified = { ...baseReceipt, createdAt: new Date().toISOString(), status: 'LIVE_VERIFIED', liveVerifiedAt: new Date().toISOString(), providerReadBack: [{ action: actionName, ...commentReadBack }] };
    appendLedger(verified);
    return verified;
  } catch (error) {
    if (error.authFailure) {
      const youtube = ensureYouTubeState();
      clearYouTubeOAuthTokens();
      youtube.oauthStatus = 'disconnected';
      youtube.oauthStatusReason = 'provider_authorization_rejected';
      storage.updateAccountStatus(actor.accountId, 'disconnected', 'provider_authorization_rejected');
      writeJson(stateFile, state);
    }
    const status = error.mutationMayHaveOccurred ? 'UNKNOWN' : 'FAILED';
    const failureCode = error.authFailure ? 'provider_authorization_rejected' : error.code || 'youtube_action_failed';
    appendLedger({ ...baseReceipt, createdAt: new Date().toISOString(), status, providerReadBack: error.providerId ? { status: 'UNVERIFIED', providerId: error.providerId } : null, providerId: error.providerId || null, error: failureCode });
    const wrapped = new Error(status === 'UNKNOWN'
      ? 'YouTube may have accepted the comment, but exact read-back failed. The action is held for reconciliation and will not be retried automatically.'
      : error.authFailure
        ? 'YouTube authorization was rejected. Reconnect before attempting another live action.'
        : 'YouTube comment action failed before exact verification.');
    wrapped.code = failureCode;
    wrapped.executionStatus = status;
    throw wrapped;
  }
}

async function executeMetaAction(candidate, pack) {
  const platform = pack.source.platform;
  if (state.provider.kind === 'demo') throw new Error('Live writes require a configured LLM route; the deterministic demo is simulation-only');
  if (!['instagram', 'facebook'].includes(platform)) throw new Error('The Meta adapter only accepts Instagram or Facebook targets');
  if (pack.source.targetScope !== 'owned') throw new Error('Meta community care is restricted to owned media');
  const actionName = pack.source.action || 'reply';
  assertLiveBuildMetadata();
  const actor = metaAccountForProviderId(platform, pack.source.channelId);
  if (!actor.capabilities?.[actionName]) throw new Error(`The connected ${platform} actor account cannot perform ${actionName}.`);
  if (pack.source.actorAccountId !== actor.accountId) throw new Error(`The analyzed action is not bound to the currently connected ${platform} actor account. Hydrate the owned media again before live execution.`);
  if (pack.source.ownershipStatus !== 'PROVIDER_LISTED_FOR_ACTOR') throw new Error('Provider ownership proof is required before a Meta action can run.');
  const targetUrl = pack.source.url;
  const key = idempotencyKey({ platform, actorAccountId: actor.accountId, targetUrl, text: candidate.text });
  const policy = assessExecutionPolicy({
    ledger: readLedger(),
    execution: state.execution,
    action: {
      platform,
      idempotencyKey: key,
      targetUrl,
      actorAccountId: actor.accountId,
      actorBudgetMaxPer24Hours: Number(actor.policy?.maxActionsPer24Hours || 5),
      requireActorAccount: true,
      targetAccount: pack.source.account,
      targetAccountId: pack.source.channelId,
      gateScore: candidate.gate.score,
      contextSources: pack.source.contextSources,
      criticStatus: candidate.modelCritic?.status || candidate.gate.metrics.modelCritic?.status || 'NOT_PERFORMED',
    },
  });
  if (policy.status !== 'PASS') throw new Error(`Execution policy blocked: ${policy.reasons.join(', ')}`);
  const accessToken = decryptAccountToken(actor);
  const targetId = pack.source.targetId || pack.source.videoId;
  const ownedMedia = platform === 'instagram'
    ? await listInstagramMedia({ actorAccountId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion })
    : await listFacebookMedia({ pageId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion });
  const ownedTarget = ownedMedia.find((item) => item.targetId === targetId && item.ownershipStatus === 'PROVIDER_LISTED_FOR_ACTOR');
  if (!ownedTarget) throw new Error('Fresh provider ownership verification did not return the target media; the action was not sent.');
  const freshContext = platform === 'instagram'
    ? await createInstagramContext({ mediaId: targetId, actorAccountId: actor.providerAccountId, ownershipProof: ownedTarget.ownerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion })
    : await createFacebookContext({ targetId, actorAccountId: actor.providerAccountId, ownershipProof: ownedTarget.ownerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion });
  if (actionName === 'reply' && !freshContext.comments.some((comment) => comment.id === pack.source.replyToId)) {
    throw new Error('Fresh provider context did not return the reply target; the action was not sent.');
  }
  const baseReceipt = {
    schema: 'social-engagement-receipt/v1',
    receiptId: `${platform.slice(0, 2)}-${key.slice(0, 16)}`,
    createdAt: new Date().toISOString(),
    mode: 'live',
    platform,
    providerApiVersion: state.meta.graphApiVersion,
    permissionSet: [...state.meta.permissions],
    targetUrl,
    targetAccount: pack.source.account,
    actorAccountId: actor.accountId,
    targetAccountId: pack.source.channelId,
    targetMediaId: pack.source.targetId || pack.source.videoId,
    targetCommentId: pack.source.replyToId || null,
    targetRanking: pack.source.discoveryRanking || null,
    action: actionName,
    commentText: candidate.text,
    commentSha256: sha256(candidate.text),
    idempotencyKey: key,
    contextFingerprint: pack.contextFingerprint,
    evidenceLocators: candidate.gate.metrics.evidenceLocators,
    gateScore: candidate.gate.score,
    gateVerdict: candidate.gate.verdict,
    gateBlocked: candidate.gate.blocked,
    ...actionReceiptFields({ candidate, actor, policy, budgetMax: Number(actor.policy?.maxActionsPer24Hours || 5) }),
    dispatchedAt: new Date().toISOString(),
  };
  appendLedger({ ...baseReceipt, status: 'DISPATCHED', providerReadBack: null });
  try {
    const providerReadBack = platform === 'instagram'
      ? await executeInstagramAction({ mediaId: pack.source.targetId || pack.source.videoId, replyToId: pack.source.replyToId, actorAccountId: actor.providerAccountId, text: candidate.text, action: actionName, accessToken, apiVersion: state.meta.graphApiVersion })
      : await executeFacebookAction({ targetId: pack.source.targetId || pack.source.videoId, replyToId: pack.source.replyToId, actorAccountId: actor.providerAccountId, text: candidate.text, action: actionName, accessToken, apiVersion: state.meta.graphApiVersion });
    const verified = { ...baseReceipt, createdAt: new Date().toISOString(), status: 'LIVE_VERIFIED', liveVerifiedAt: new Date().toISOString(), providerId: providerReadBack.providerId, providerReadBack: [{ action: actionName, ...providerReadBack }] };
    appendLedger(verified);
    return verified;
  } catch (error) {
    if (error.authFailure) {
      storage.updateAccountStatus(actor.accountId, 'disconnected', 'provider_authorization_rejected');
      state.meta.status = 'error';
      state.meta.statusReason = 'provider_authorization_rejected';
      writeJson(stateFile, state);
    }
    const status = error.mutationMayHaveOccurred ? 'UNKNOWN' : 'FAILED';
    const failureCode = error.authFailure ? 'provider_authorization_rejected' : error.code || 'meta_action_failed';
    appendLedger({ ...baseReceipt, createdAt: new Date().toISOString(), status, providerId: error.providerId || null, providerReadBack: error.providerId ? { status: 'UNVERIFIED', providerId: error.providerId } : null, error: failureCode });
    const wrapped = new Error(status === 'UNKNOWN'
      ? `Meta may have accepted the ${actionName}, but exact read-back failed. The action is held for reconciliation and will not be retried automatically.`
      : error.authFailure
        ? 'Meta authorization was rejected. Reconnect before attempting another live action.'
        : 'Meta action failed before exact verification.');
    wrapped.code = failureCode;
    wrapped.executionStatus = status;
    throw wrapped;
  }
}

async function verifyReconciliation(idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) throw new Error('A reconciliation idempotency key is required.');
  const item = storage.listReconciliation().find((row) => row.idempotencyKey === key);
  if (!item) throw new Error('The reconciliation item is not open.');
  const latest = storage.readLatestReceipt(key);
  if (!latest || !['UNKNOWN', 'DISPATCHED', 'PROVIDER_ACCEPTED'].includes(latest.status)) throw new Error('The latest mutation state is not unresolved; no reconciliation is required.');
  const providerId = String(latest.providerId || (Array.isArray(latest.providerReadBack) ? latest.providerReadBack[0]?.providerId : latest.providerReadBack?.providerId) || '').trim();
  if (!providerId) throw new Error('The provider did not return an object ID, so this mutation cannot be safely reconciled automatically.');
  const actor = storage.getAccount(latest.actorAccountId);
  if (!actor || actor.status !== 'connected') throw new Error('Reconnect the original actor account before provider reconciliation.');
  const accessToken = actor.platform === 'youtube' ? await ensureYouTubeAccessToken() : decryptAccountToken(actor);
  let evidence;
  try {
    evidence = actor.platform === 'youtube'
      ? await reconcileYouTubeComment({ commentId: providerId, text: latest.commentText, accessToken })
      : ['instagram', 'facebook'].includes(actor.platform)
        ? await reconcileMetaAction({ providerId, text: latest.commentText, platform: actor.platform, actorAccountId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion })
        : null;
  } catch (error) {
    if (error.authFailure) {
      storage.updateAccountStatus(actor.accountId, 'disconnected', 'provider_authorization_rejected');
      if (actor.platform === 'youtube') {
        const youtube = ensureYouTubeState();
        clearYouTubeOAuthTokens();
        youtube.oauthStatus = 'disconnected';
        youtube.oauthStatusReason = 'provider_authorization_rejected';
      } else {
        state.meta.status = 'error';
        state.meta.statusReason = 'provider_authorization_rejected';
      }
      writeJson(stateFile, state);
    }
    throw new Error('Provider reconciliation could not complete. The mutation remains open and retry-locked.');
  }
  if (!evidence) throw new Error(`Reconciliation is not implemented for ${actor.platform}.`);
  const verified = evidence.exists === true && evidence.exact === true;
  const finalReceipt = {
    ...latest,
    receiptId: `${String(latest.receiptId || 'mutation').slice(0, 80)}-reconciled-${sha256(`${key}|${providerId}`).slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    status: verified ? 'LIVE_VERIFIED' : 'FAILED',
    providerId,
    providerReadBack: [{ action: 'reconciliation', ...evidence }],
    resolvedBy: 'provider_reconciliation',
    resolution: verified ? 'provider_confirmed' : String(evidence.reason || 'provider_not_confirmed'),
    reconciledAt: new Date().toISOString(),
    ...(verified ? {} : { error: String(evidence.reason || 'provider_not_confirmed') }),
  };
  appendLedger(finalReceipt);
  return { receipt: finalReceipt, state: publicState() };
}

async function runMetaCycle(platform) {
  if (!['instagram', 'facebook'].includes(platform)) throw new Error('Owned Meta cycle accepts Instagram or Facebook only.');
  if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
  if (!state.execution.autonomyEnabled) throw new Error('Enable bounded auto-run before starting an owned-media cycle');
  const actor = storage.listAccounts({ platform, includeDisconnected: false }).find((account) => account.status === 'connected' && account.capabilities?.reply);
  if (!actor) throw new Error(`Connect a ${platform} actor account before starting an owned-media cycle.`);
  const accessToken = decryptAccountToken(actor);
  const ownedMedia = platform === 'instagram'
    ? await listInstagramMedia({ actorAccountId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion })
    : await listFacebookMedia({ pageId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion });
  const rankingProfile = { ...state.profile, ownedChannelIds: [], excludedChannelIds: [] };
  const rankedTargets = rankDiscoveryTargets({ targets: ownedMedia, profile: rankingProfile, history: readLedger(), lookbackDays: state.execution.discoveryLookbackDays });
  const results = [];
  let completedActions = 0;
  for (const target of rankedTargets) {
    if (completedActions >= Number(state.execution.maxCommentsPerRun || 3)) break;
    if (!target.ranking.eligible) {
      results.push({ targetId: target.targetId, targetUrl: target.url, targetAccount: target.account, status: 'FILTERED_BY_RANKING', reason: target.ranking.exclusionReason, targetRanking: target.ranking });
      continue;
    }
    let context;
    try {
      context = platform === 'instagram'
        ? await createInstagramContext({ mediaId: target.targetId, actorAccountId: actor.providerAccountId, ownershipProof: actor.providerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion })
        : await createFacebookContext({ targetId: target.targetId, actorAccountId: actor.providerAccountId, ownershipProof: actor.providerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion });
      recordContextMetrics(context, actor.accountId);
      context.discoveryRanking = rankDiscoveryTarget({ target, context, profile: rankingProfile, history: readLedger(), lookbackDays: state.execution.discoveryLookbackDays });
      if (!context.comments.length) {
        results.push({ targetId: target.targetId, targetUrl: target.url, targetAccount: target.account, status: 'NO_INBOUND_COMMENTS', targetRanking: context.discoveryRanking });
        continue;
      }
      for (const comment of context.comments) {
        if (completedActions >= Number(state.execution.maxCommentsPerRun || 3)) break;
        const replyContext = { ...context, action: 'reply', replyToId: comment.id, targetCommentId: comment.id, actorAccountId: actor.accountId };
        const analysis = await runAnalysis({ context: replyContext, profile: state.profile, provider: configuredProvider(), history: readLedger(), exemplars: storage.listExemplars({ platform }) });
        analysis.contextPayloadFingerprint = contextPayloadFingerprint(replyContext);
        const selected = analysis.candidates.find((candidate) => candidate.id === analysis.selectedId);
        if (!selected) {
          results.push({ targetId: target.targetId, targetUrl: target.url, targetAccount: target.account, commentId: comment.id, status: 'BLOCKED_BY_GATES', targetRanking: analysis.pack.source.discoveryRanking, reasons: analysis.candidates.flatMap((candidate) => candidate.gate.blocked).slice(0, 8) });
          continue;
        }
        const receipt = state.execution.liveWritesEnabled
          ? await executeMetaAction(selected, analysis.pack)
          : simulationReceipt({ platform, targetUrl: analysis.pack.source.url, candidate: selected, pack: analysis.pack });
        if (!state.execution.liveWritesEnabled) appendLedger(receipt);
        completedActions += 1;
        state.context = replyContext;
        state.lastAnalysis = analysis;
        results.push({ targetId: target.targetId, targetUrl: target.url, targetAccount: target.account, commentId: comment.id, status: receipt.status, receiptId: receipt.receiptId, targetRanking: analysis.pack.source.discoveryRanking });
      }
    } catch (error) {
      results.push({ targetId: target.targetId, targetUrl: target.url, targetAccount: target.account, status: error.executionStatus || 'SKIPPED', reason: String(error.message || error).slice(0, 300) });
      if (error.executionStatus === 'UNKNOWN') {
        state.execution.paused = true;
        break;
      }
    }
  }
  writeJson(stateFile, state);
  return { platform, discovered: ownedMedia.length, ranked: rankedTargets.length, completedActions, results, lastAnalysis: state.lastAnalysis || null, state: publicState() };
}

async function runYouTubeCycle(input = {}) {
  if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
  if (!state.execution.autonomyEnabled) throw new Error('Enable bounded auto-run before starting a niche cycle');
  const apiKey = decryptSecret(state.youtube?.apiKeyCipher);
  let accessToken = '';
  if (state.youtube?.refreshTokenCipher) {
    try {
      accessToken = await ensureYouTubeAccessToken();
    } catch (error) {
      if (!apiKey || state.execution.liveWritesEnabled) throw error;
    }
  }
  if (!apiKey && !accessToken) throw new Error('YouTube Data API access is required for niche discovery. Connect YouTube or add a Data API key.');
  const fallbackQuery = (state.profile.nicheTerms || []).slice(0, 4).join('|');
  const query = String(input?.query || fallbackQuery).trim().slice(0, 240);
  const lookbackMs = Number(state.execution.discoveryLookbackDays || 7) * 86400000;
  const discoveredTargets = await discoverVideos({
    query,
    apiKey,
    accessToken,
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
      const fetchedContext = await fetchContext({ url: target.url, apiKey, accessToken });
      const youtubeActor = storage.listAccounts({ platform: 'youtube', includeDisconnected: false }).find((account) => account.credentialRef === 'youtube:primary' && account.status === 'connected');
      const context = { ...fetchedContext, actorAccountId: youtubeActor?.accountId || null };
      context.discoveryRanking = rankDiscoveryTarget({ target, context, profile: state.profile, history: readLedger(), lookbackDays: state.execution.discoveryLookbackDays });
      const analysis = await runAnalysis({ context, profile: state.profile, provider: configuredProvider(), history: readLedger().filter((row) => row.status === 'LIVE_VERIFIED'), exemplars: storage.listExemplars({ platform: 'youtube' }) });
      analysis.contextPayloadFingerprint = contextPayloadFingerprint(context);
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
  return { query, platform: 'youtube', discovered: discoveredTargets.length, ranked: targets.length, completedActions, results, lastAnalysis: state.lastAnalysis || null, state: publicState() };
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
    const previous = { ...state.execution };
    state.execution = {
      ...state.execution,
      autonomyEnabled: execution.autonomyEnabled === undefined ? state.execution.autonomyEnabled : Boolean(execution.autonomyEnabled),
      liveWritesEnabled: execution.liveWritesEnabled === undefined ? state.execution.liveWritesEnabled : Boolean(execution.liveWritesEnabled),
      paused: execution.paused === undefined ? state.execution.paused : Boolean(execution.paused),
      cycleIntervalMinutes: execution.cycleIntervalMinutes === undefined
        ? normalizeIntervalMinutes(state.execution.cycleIntervalMinutes)
        : normalizeIntervalMinutes(execution.cycleIntervalMinutes),
      enabledPlatforms: execution.enabledPlatforms === undefined
        ? normalizePlatforms(state.execution.enabledPlatforms)
        : normalizePlatforms(execution.enabledPlatforms),
      maxCommentsPerRun: clampNumber(execution.maxCommentsPerRun, state.execution.maxCommentsPerRun, 1, 10),
      maxCommentsPer24Hours: clampNumber(execution.maxCommentsPer24Hours, state.execution.maxCommentsPer24Hours, 1, 50),
      discoveryLookbackDays: clampNumber(execution.discoveryLookbackDays, state.execution.discoveryLookbackDays, 1, 30),
      targetCooldownHours: clampNumber(execution.targetCooldownHours, state.execution.targetCooldownHours, 1, 2160),
      accountCooldownHours: clampNumber(execution.accountCooldownHours, state.execution.accountCooldownHours, 1, 720),
      minimumGateScore: clampNumber(execution.minimumGateScore, state.execution.minimumGateScore, 60, 100),
    };
    writeJson(stateFile, state);
    syncAutomationRuntime({
      runNow: Boolean(state.execution.autonomyEnabled && !state.execution.paused && (!previous.autonomyEnabled || previous.paused)),
      reason: previous.paused && !state.execution.paused ? 'resumed' : 'configuration',
    });
    return publicState();
  });
  ipcMain.handle('provider:save', (event, provider) => {
    assertSender(event);
    const safeProvider = {
      kind: provider.kind === 'openai-compatible' ? 'openai-compatible' : 'demo',
      name: String(provider.name || '').trim().slice(0, 80),
      model: String(provider.model || '').trim().slice(0, 160),
      visionModel: String(provider.visionModel || '').trim().slice(0, 160),
      transcriptionModel: String(provider.transcriptionModel || '').trim().slice(0, 160),
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
    const youtube = ensureYouTubeState();
    const nextClientId = secrets.oauthClientId === undefined
      ? youtube.oauthClientId
      : String(secrets.oauthClientId || '').trim().slice(0, 240) || DEFAULT_YOUTUBE_OAUTH_CLIENT_ID;
    if (nextClientId !== youtube.oauthClientId) {
      clearYouTubeOAuthTokens();
      youtube.oauthStatus = 'disconnected';
      youtube.oauthStatusReason = 'oauth_client_changed';
    }
  youtube.oauthClientId = nextClientId;
  if (secrets.apiKey) youtube.apiKeyCipher = encryptSecret(String(secrets.apiKey));
  if (secrets.oauthClientSecret) youtube.oauthClientSecretCipher = encryptSecret(String(secrets.oauthClientSecret));
  if (youtube.oauthStatus === 'disconnected' && (youtube.oauthClientId || youtube.apiKeyCipher)) youtube.oauthStatus = 'configured';
  writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('youtube:connect', async (event) => {
    assertSender(event);
    return connectYouTube();
  });
  ipcMain.handle('youtube:disconnect', async (event) => {
    assertSender(event);
    return disconnectYouTube();
  });
  ipcMain.handle('meta:save-secrets', (event, input) => {
    assertSender(event);
    const meta = ensureMetaState();
    const nextAppId = String(input?.appId || '').trim().slice(0, 240) || DEFAULT_META_APP_ID;
    if (nextAppId !== meta.appId) {
      meta.status = 'disconnected';
      meta.statusReason = 'meta_app_changed';
    }
    meta.appId = nextAppId;
    meta.graphApiVersion = /^v\d+\.\d+$/.test(String(input?.graphApiVersion || '')) ? String(input.graphApiVersion) : META_API_VERSION;
    if (input?.appSecret) meta.appSecretCipher = encryptSecret(String(input.appSecret));
    if (meta.status === 'disconnected' && meta.appId && meta.appSecretCipher) meta.status = 'configured';
    writeJson(stateFile, state);
    return publicState();
  });
  ipcMain.handle('meta:connect', async (event) => {
    assertSender(event);
    return connectMeta();
  });
  ipcMain.handle('meta:disconnect', async (event) => {
    assertSender(event);
    return disconnectMeta();
  });
  ipcMain.handle('youtube:fetch-context', async (event, input) => {
    assertSender(event);
    const apiKey = decryptSecret(state.youtube?.apiKeyCipher);
    let accessToken = '';
    if (state.youtube?.refreshTokenCipher) {
      try {
        accessToken = await ensureYouTubeAccessToken();
      } catch (error) {
        if (!apiKey) throw error;
      }
    }
    const fetchedContext = await fetchContext({ url: String(input?.url || ''), apiKey, accessToken });
    const youtubeActor = storage.listAccounts({ platform: 'youtube', includeDisconnected: false }).find((account) => account.credentialRef === 'youtube:primary' && account.status === 'connected');
    const context = { ...fetchedContext, actorAccountId: youtubeActor?.accountId || null };
    state.context = context;
    recordContextMetrics(context, youtubeActor?.accountId || null);
    writeJson(stateFile, state);
    return { context, state: publicState() };
  });
  ipcMain.handle('meta:fetch-context', async (event, input) => {
    assertSender(event);
    const platform = String(input?.platform || '').toLowerCase();
    const actor = metaAccountForProviderId(platform, String(input?.actorAccountId || input?.channelId || ''));
    const accessToken = decryptAccountToken(actor);
    const ownedMedia = platform === 'instagram'
      ? await listInstagramMedia({ actorAccountId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion })
      : await listFacebookMedia({ pageId: actor.providerAccountId, accessToken, apiVersion: state.meta.graphApiVersion });
    const targetId = String(input?.targetId || '').trim();
    const ownedTarget = ownedMedia.find((item) => item.targetId === targetId && item.ownershipStatus === 'PROVIDER_LISTED_FOR_ACTOR');
    if (!ownedTarget) {
      const error = new Error(`The ${platform} target was not returned by the connected actor's owned-media endpoint.`);
      error.code = 'owned_media_not_found';
      throw error;
    }
    const hydratedContext = platform === 'instagram'
      ? await createInstagramContext({ mediaId: targetId, actorAccountId: actor.providerAccountId, ownershipProof: ownedTarget.ownerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion })
      : await createFacebookContext({ targetId, actorAccountId: actor.providerAccountId, ownershipProof: ownedTarget.ownerAccountId, ownedMedia, accessToken, apiVersion: state.meta.graphApiVersion });
    const context = { ...hydratedContext, actorAccountId: actor.accountId };
    state.context = context;
    recordContextMetrics(context, actor.accountId);
    writeJson(stateFile, state);
    return { context, state: publicState() };
  });
  ipcMain.handle('media:choose', async (event) => {
    assertSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose authorized media',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }, { name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('media:inspect', async (event, input) => {
    assertSender(event);
    try {
      const bundle = await inspectAuthorizedMedia({
        filePath: input?.filePath,
        transcriptPath: input?.transcriptPath,
        mediaId: input?.mediaId,
        provider: configuredProvider(),
      });
      state.context = {
        ...state.context,
        ...bundle,
        contextSources: [...new Set([...(state.context?.contextSources || []), ...(bundle.contextSources || [])])],
      };
      writeJson(stateFile, state);
      return { bundle, state: publicState() };
    } catch (error) {
      const safe = new Error(error?.code === 'media_process_failed' ? 'The authorized media could not be inspected by the local media tools.' : String(error?.message || 'Authorized media inspection failed.').slice(0, 240));
      safe.code = error?.code || 'authorized_media_inspection_failed';
      throw safe;
    }
  });
  ipcMain.handle('analysis:run', async (event, context) => {
    assertSender(event);
    const provider = configuredProvider();
    const incoming = context || state.context || RUNTIME_DEFAULT_CONTEXT;
    const previous = state.context || RUNTIME_DEFAULT_CONTEXT;
    const samePayload = contextPayloadFingerprint(incoming) === contextPayloadFingerprint(previous);
    state.context = samePayload
      ? {
        ...incoming,
        videoId: String(incoming.videoId || previous.videoId || ''),
        channelId: String(incoming.channelId || previous.channelId || ''),
        contextSources: previous.contextSources || incoming.contextSources || ['manual_context_form'],
        discoveryRanking: previous.discoveryRanking || incoming.discoveryRanking || null,
      }
      : manualContextOnly(incoming);
    const result = await runAnalysis({ context: state.context, profile: state.profile, provider, history: readLedger(), exemplars: storage.listExemplars({ platform: state.context.platform }) });
    result.contextPayloadFingerprint = contextPayloadFingerprint(state.context);
    state.lastAnalysis = result;
    writeJson(stateFile, state);
    return result;
  });
  ipcMain.handle('llm:chat', async (event, input) => {
    assertSender(event);
    const provider = configuredProvider();
    return chatWithProvider({ message: input?.message, context: state.context || RUNTIME_DEFAULT_CONTEXT, profile: state.profile, provider });
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
  ipcMain.handle('execution:meta', async (event, input) => {
    assertSender(event);
    if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
    if (!state.execution.autonomyEnabled || !state.execution.liveWritesEnabled) throw new Error('Live writes are not armed in Settings');
    const { candidate, pack } = trustedAction(input);
    try {
      return await executeMetaAction(candidate, pack);
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
    return runPlatformCycle('youtube', input);
  });
  ipcMain.handle('execution:meta-cycle', async (event, input) => {
    assertSender(event);
    if (state.execution.paused) throw new Error('Autonomy is paused by the kill switch');
    if (!state.execution.autonomyEnabled) throw new Error('Enable bounded auto-run before starting an owned-media cycle');
    const result = await runPlatformCycle(String(input?.platform || '').toLowerCase());
    if (result.results.some((item) => item.status === 'UNKNOWN')) {
      state.execution.paused = true;
      writeJson(stateFile, state);
    }
    return result;
  });
  ipcMain.handle('execution:automation-now', async (event) => {
    assertSender(event);
    if (!state.execution.autonomyEnabled) throw new Error('Enable autonomous run once before starting automation.');
    const result = await automationRunner.trigger('operator');
    return { ...result, state: publicState() };
  });
  ipcMain.handle('ledger:list', (event) => {
    assertSender(event);
    return latestLedgerRows(readLedger()).slice(-50).reverse();
  });
  ipcMain.handle('accounts:list', (event) => {
    assertSender(event);
    return storage.listAccounts();
  });
  ipcMain.handle('reconciliation:list', (event) => {
    assertSender(event);
    return storage.listReconciliation();
  });
  ipcMain.handle('reconciliation:verify', async (event, input) => {
    assertSender(event);
    return verifyReconciliation(input?.idempotencyKey);
  });
  ipcMain.handle('storage:status', (event) => {
    assertSender(event);
    return storage.status();
  });
  ipcMain.handle('metrics:list', (event, input) => {
    assertSender(event);
    return storage.listMetricSnapshots({ platform: input?.platform, targetAccountId: input?.targetAccountId, limit: input?.limit || 100 });
  });
  ipcMain.handle('exemplars:list', (event, input) => {
    assertSender(event);
    return storage.listExemplars({ platform: input?.platform });
  });
  ipcMain.handle('evaluation-examples:list', (event, input) => {
    assertSender(event);
    return storage.listEvaluationExamples({ platform: input?.platform, actorAccountId: input?.actorAccountId, limit: input?.limit || 100 });
  });
  ipcMain.handle('exemplars:pin', (event, input) => {
    assertSender(event);
    const platform = String(input?.platform || '').trim().toLowerCase();
    const action = String(input?.action || 'comment').trim().toLowerCase();
    const text = String(input?.text || '').replace(/\s+/g, ' ').trim();
    const evidence = Array.isArray(input?.evidence) ? input.evidence.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8) : [];
    if (!['youtube', 'instagram', 'facebook', 'tiktok'].includes(platform) || !text || !evidence.length) throw new Error('A pinned exemplar needs a supported platform, copy, and source evidence.');
    const sourceHash = sha256(JSON.stringify({ platform, action, text, evidence }));
    const exemplar = storage.pinExemplar({ exemplarId: `ex-${sourceHash.slice(0, 24)}`, platform, action, text, evidence, sourceHash, version: 1 });
    return { exemplar, state: publicState() };
  });
  ipcMain.handle('capabilities:list', (event) => {
    assertSender(event);
    return PLATFORM_CAPABILITIES;
  });
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  stateFile = path.join(dataDir, 'state.json');
  ledgerFile = path.join(dataDir, 'engagement-ledger.jsonl');
  storage = new StudioStorage({ dataDir, legacyStatePath: stateFile, legacyLedgerPath: ledgerFile }).open({ defaultState: defaultState() });
  state = storage.loadState(defaultState());
  ensureYouTubeState();
  state.profile = { ...DEFAULT_PROFILE, ...(state.profile || {}) };
  state.context = state.context && !isSyntheticContext(state.context)
    ? state.context
    : { ...RUNTIME_DEFAULT_CONTEXT, comments: [], transcriptSegments: [], visualObservations: [], visualProvenance: [] };
  state.execution = normalizeAutomationExecution({ ...defaultState().execution, ...(state.execution || {}) });
  state.provider = { kind: 'demo', name: 'Local demo', model: 'deterministic-demo', visionModel: '', transcriptionModel: '', criticModel: '', baseUrl: '', ...(state.provider || {}) };
  state.meta = { ...defaultState().meta, ...(state.meta || {}) };
  ensureMetaState();
  if (state.youtube.oauthStatus === 'authorizing') {
    state.youtube.oauthStatus = 'disconnected';
    state.youtube.oauthStatusReason = 'oauth_interrupted';
  }
  if (state.meta.status === 'authorizing') {
    state.meta.status = 'disconnected';
    state.meta.statusReason = 'oauth_interrupted';
  }
  ensureAutomationState();
  writeJson(stateFile, state);
  setupAutomationRunner();
  registerHandlers();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  createWindow();
  syncAutomationRuntime({ runNow: Boolean(state.execution.autonomyEnabled), reason: 'startup' });
});

app.on('window-all-closed', () => {
  automationRunner?.stop('app_closed');
  if (process.platform !== 'darwin') app.quit();
});

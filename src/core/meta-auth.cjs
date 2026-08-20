const crypto = require('node:crypto');
const http = require('node:http');
const {
  assertLoopbackRedirect,
  createPkcePair,
  waitForLoopbackCallback,
} = require('./youtube-auth.cjs');

const META_API_VERSION = 'v26.0';
const META_AUTH_ENDPOINT = 'https://www.facebook.com';
const META_GRAPH_ENDPOINT = 'https://graph.facebook.com';
const META_PERMISSIONS = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_manage_metadata',
  'instagram_basic',
  'instagram_manage_comments',
];

function metaError(code, status = 0) {
  const error = new Error(`Meta OAuth ${code}`);
  error.code = code;
  error.status = status;
  return error;
}

function version(value) {
  const candidate = String(value || META_API_VERSION).trim();
  return /^v\d+\.\d+$/.test(candidate) ? candidate : META_API_VERSION;
}

function graphUrl(apiVersion, pathname, params = {}) {
  const url = new URL(`${META_GRAPH_ENDPOINT}/${version(apiVersion)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url;
}

function buildMetaAuthorizationUrl({ appId, redirectUri, state, codeChallenge, apiVersion = META_API_VERSION, scopes = META_PERMISSIONS } = {}) {
  if (!String(appId || '').trim()) throw metaError('app_id_missing');
  if (!String(state || '').trim() || !String(codeChallenge || '').trim()) throw metaError('authorization_request_invalid');
  assertLoopbackRedirect(redirectUri);
  const url = new URL(`/${version(apiVersion)}/dialog/oauth`, META_AUTH_ENDPOINT);
  url.searchParams.set('client_id', String(appId).trim());
  url.searchParams.set('redirect_uri', String(redirectUri));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))].join(','));
  url.searchParams.set('state', String(state));
  url.searchParams.set('code_challenge', String(codeChallenge));
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function providerCode(payload, status) {
  const message = String(payload?.error?.message || payload?.error?.type || payload?.error?.code || '').toLowerCase();
  if (/permission|oauth|token|auth/.test(message) || status === 401) return 'authorization_rejected';
  if (status >= 500) return 'meta_server_error';
  return 'meta_request_failed';
}

async function metaRequest(url, { fetchImpl = globalThis.fetch, method = 'GET', accessToken = '' } = {}) {
  if (typeof fetchImpl !== 'function') throw metaError('runtime_unavailable');
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(String(accessToken || '').trim() ? { Authorization: `Bearer ${String(accessToken).trim()}` } : {}),
      },
    });
  } catch (error) {
    throw metaError('network_error');
  }
  const payload = await readJson(response);
  if (!response.ok || payload.error) throw metaError(providerCode(payload, response.status), response.status);
  return payload;
}

function normalizeMetaToken(payload) {
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) throw metaError('token_response_invalid');
  const expiresIn = Number(payload?.expires_in);
  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + Math.round(expiresIn * 1000) : null,
    dataAccessExpiresAt: Number.isFinite(Number(payload?.data_access_expiration_time)) ? Number(payload.data_access_expiration_time) * 1000 : null,
    tokenType: String(payload.token_type || 'Bearer'),
  };
}

async function exchangeMetaCode({ appId, appSecret, redirectUri, code, codeVerifier, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch }) {
  if (!String(appId || '').trim() || !String(appSecret || '').trim() || !String(redirectUri || '').trim() || !String(code || '').trim() || !String(codeVerifier || '').trim()) throw metaError('authorization_request_invalid');
  assertLoopbackRedirect(redirectUri);
  const url = graphUrl(apiVersion, '/oauth/access_token', {
    client_id: String(appId).trim(),
    client_secret: String(appSecret),
    redirect_uri: String(redirectUri),
    code: String(code),
    code_verifier: String(codeVerifier),
  });
  const shortLived = normalizeMetaToken(await metaRequest(url, { fetchImpl }));
  const longLivedUrl = graphUrl(apiVersion, '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: String(appId).trim(),
    client_secret: String(appSecret),
    fb_exchange_token: shortLived.accessToken,
  });
  try {
    return normalizeMetaToken(await metaRequest(longLivedUrl, { fetchImpl }));
  } catch (error) {
    if (['authorization_rejected', 'meta_server_error'].includes(error.code)) throw error;
    return shortLived;
  }
}

async function authorizeMetaDesktop({ appId, appSecret, apiVersion = META_API_VERSION, openExternal, fetchImpl = globalThis.fetch, timeoutMs = 300000 } = {}) {
  if (typeof openExternal !== 'function') throw metaError('browser_open_unavailable');
  const pkce = createPkcePair();
  const state = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    const onError = () => {
      server.removeListener('error', onError);
      reject(metaError('loopback_bind_failed'));
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const authorizationUrl = buildMetaAuthorizationUrl({ appId, redirectUri, state, codeChallenge: pkce.challenge, apiVersion });
  const callback = waitForLoopbackCallback(server, redirectUri, state, timeoutMs);
  try {
    await openExternal(authorizationUrl.toString());
  } catch (error) {
    callback.cancel(metaError('browser_open_failed'));
    throw metaError('browser_open_failed');
  }
  try {
    const result = await callback.promise;
    return exchangeMetaCode({ appId, appSecret, redirectUri, code: result.code, codeVerifier: pkce.verifier, apiVersion, fetchImpl });
  } catch (error) {
    const wrapped = metaError(String(error?.code || 'authorization_failed'));
    wrapped.status = Number(error?.status || 0);
    throw wrapped;
  }
}

function normalizeManagedAccounts(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const accounts = [];
  for (const row of rows) {
    const pageId = String(row?.id || '').trim();
    if (!pageId) continue;
    const pageName = String(row?.name || pageId).trim();
    const tasks = Array.isArray(row?.tasks) ? row.tasks.map((task) => String(task || '').toUpperCase()) : [];
    const canModerate = tasks.includes('MODERATE') || tasks.includes('MANAGE');
    const capabilities = { comment: canModerate, reply: canModerate, webhook: canModerate };
    accounts.push({
      platform: 'facebook',
      providerAccountId: pageId,
      displayName: pageName,
      accessToken: String(row?.access_token || '').trim(),
      capabilities,
      tasks,
      instagramAccountId: String(row?.instagram_business_account?.id || '').trim() || null,
    });
    if (row?.instagram_business_account?.id) accounts.push({
      platform: 'instagram',
      providerAccountId: String(row.instagram_business_account.id).trim(),
      displayName: `${pageName} · Instagram`,
      accessToken: String(row?.access_token || '').trim(),
      capabilities,
      tasks,
      pageId,
    });
  }
  return accounts;
}

async function fetchManagedAccounts({ accessToken, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch } = {}) {
  if (!String(accessToken || '').trim()) throw metaError('access_token_missing');
  const url = graphUrl(apiVersion, '/me/accounts', {
    fields: 'id,name,access_token,tasks,instagram_business_account',
  });
  return normalizeManagedAccounts(await metaRequest(url, { fetchImpl, accessToken }));
}

module.exports = {
  META_API_VERSION,
  META_AUTH_ENDPOINT,
  META_GRAPH_ENDPOINT,
  META_PERMISSIONS,
  buildMetaAuthorizationUrl,
  authorizeMetaDesktop,
  exchangeMetaCode,
  fetchManagedAccounts,
  graphUrl,
  metaError,
  metaRequest,
  normalizeManagedAccounts,
  normalizeMetaToken,
  version,
};

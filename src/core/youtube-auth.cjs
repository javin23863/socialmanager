const crypto = require('node:crypto');
const http = require('node:http');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const YOUTUBE_COMMENT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const REFRESH_SKEW_MS = 60_000;

function oauthError(code, status = 0) {
  const error = new Error(`YouTube OAuth ${code}`);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeScopes(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/\s+/))
    .map((scope) => String(scope || '').trim())
    .filter(Boolean))];
}

function assertLoopbackRedirect(redirectUri) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch (error) {
    throw new Error('YouTube OAuth redirect must be a loopback URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || !url.port) throw new Error('YouTube OAuth redirect must be a loopback URL');
  return url;
}

function createPkcePair() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (!String(clientId || '').trim()) throw new Error('YouTube OAuth client ID is required');
  if (!String(state || '').trim() || !String(codeChallenge || '').trim()) throw new Error('YouTube OAuth state and PKCE challenge are required');
  const redirect = assertLoopbackRedirect(redirectUri);
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', String(clientId).trim());
  url.searchParams.set('redirect_uri', String(redirectUri));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', YOUTUBE_COMMENT_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', String(state));
  url.searchParams.set('code_challenge', String(codeChallenge));
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

function mapProviderError(status, payload) {
  const providerCode = String(payload?.error || '').toLowerCase();
  if (['access_denied', 'invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'unauthorized_client'].includes(providerCode)) return providerCode;
  if (status === 401) return 'unauthorized';
  if (status >= 500) return 'oauth_server_error';
  return 'oauth_request_failed';
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

async function tokenRequest(body, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw oauthError('oauth_runtime_unavailable');
  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw oauthError('oauth_network_error');
  }
  const payload = await readJson(response);
  if (!response.ok || payload.error) throw oauthError(mapProviderError(response.status, payload), response.status);
  return payload;
}

function normalizeTokenPayload(payload, { previousScopes = [], requireRefresh = false } = {}) {
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
  const refreshToken = typeof payload?.refresh_token === 'string' ? payload.refresh_token.trim() : '';
  const expiresIn = Number(payload?.expires_in);
  const grantedScopes = normalizeScopes(payload?.scope || previousScopes);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw oauthError('token_response_invalid');
  if (!grantedScopes.includes(YOUTUBE_COMMENT_SCOPE)) throw oauthError('required_scope_not_granted');
  if (requireRefresh && !refreshToken) throw oauthError('refresh_token_missing');
  return {
    accessToken,
    refreshToken: refreshToken || null,
    expiresAt: Date.now() + Math.round(expiresIn * 1000),
    grantedScopes,
    tokenType: String(payload.token_type || 'Bearer'),
  };
}

async function exchangeAuthorizationCode({ clientId, clientSecret = '', redirectUri, code, codeVerifier, fetchImpl = globalThis.fetch }) {
  if (!String(clientId || '').trim() || !String(code || '').trim() || !String(codeVerifier || '').trim()) throw oauthError('authorization_request_invalid');
  assertLoopbackRedirect(redirectUri);
  const body = {
    client_id: String(clientId).trim(),
    code: String(code),
    code_verifier: String(codeVerifier),
    grant_type: 'authorization_code',
    redirect_uri: String(redirectUri),
  };
  if (String(clientSecret || '').trim()) body.client_secret = String(clientSecret);
  const payload = await tokenRequest(body, fetchImpl);
  return normalizeTokenPayload(payload, { requireRefresh: true });
}

async function refreshAccessToken({ clientId, clientSecret = '', refreshToken, previousScopes = [YOUTUBE_COMMENT_SCOPE], fetchImpl = globalThis.fetch }) {
  if (!String(clientId || '').trim() || !String(refreshToken || '').trim()) throw oauthError('refresh_request_invalid');
  const body = {
    client_id: String(clientId).trim(),
    refresh_token: String(refreshToken),
    grant_type: 'refresh_token',
  };
  if (String(clientSecret || '').trim()) body.client_secret = String(clientSecret);
  const payload = await tokenRequest(body, fetchImpl);
  return normalizeTokenPayload(payload, { previousScopes, requireRefresh: false });
}

async function revokeToken({ token, fetchImpl = globalThis.fetch }) {
  if (!String(token || '').trim()) return { revoked: false, reason: 'no_token' };
  if (typeof fetchImpl !== 'function') throw oauthError('oauth_runtime_unavailable');
  let response;
  try {
    response = await fetchImpl(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: String(token) }).toString(),
    });
  } catch (error) {
    throw oauthError('oauth_network_error');
  }
  if (!response.ok) {
    const payload = await readJson(response);
    throw oauthError(mapProviderError(response.status, payload), response.status);
  }
  return { revoked: true };
}

function isAccessTokenUsable({ accessToken, expiresAt, skewMs = REFRESH_SKEW_MS }) {
  return Boolean(String(accessToken || '').trim()) && Number.isFinite(Number(expiresAt)) && Number(expiresAt) > Date.now() + Number(skewMs || 0);
}

function callbackPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Social Engagement Studio</title></head><body><p>Authorization received. You can close this window and return to Social Engagement Studio.</p></body></html>';
}

function waitForLoopbackCallback(server, redirectUri, expectedState, timeoutMs) {
  let finish;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, oauthError('oauth_timeout')), Math.max(1000, Number(timeoutMs) || 300000));
    finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners('request');
      server.removeAllListeners('error');
      try { server.close(); } catch (error) { /* already closed */ }
      settle(value);
    };
    cancel = (error) => finish(reject, error);
    server.on('error', () => finish(reject, oauthError('loopback_callback_failed')));
    server.on('request', (request, response) => {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }
      let callback;
      try {
        callback = new URL(request.url, redirectUri);
      } catch (error) {
        response.statusCode = 400;
        response.end();
        finish(reject, oauthError('callback_invalid'));
        return;
      }
      const expectedRedirect = new URL(redirectUri);
      if (callback.origin !== expectedRedirect.origin || callback.pathname !== expectedRedirect.pathname) {
        response.statusCode = 400;
        response.end();
        finish(reject, oauthError('callback_invalid'));
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(callbackPage());
      if (callback.searchParams.get('state') !== expectedState) {
        finish(reject, oauthError('state_mismatch'));
        return;
      }
      const providerError = callback.searchParams.get('error');
      if (providerError) {
        finish(reject, oauthError(providerError === 'access_denied' ? 'access_denied' : 'oauth_authorization_failed'));
        return;
      }
      const code = callback.searchParams.get('code');
      if (!code) {
        finish(reject, oauthError('authorization_code_missing'));
        return;
      }
      finish(resolve, { code });
    });
  });
  return { promise, cancel };
}

async function authorizeDesktop({ clientId, clientSecret = '', openExternal, fetchImpl = globalThis.fetch, timeoutMs = 300000 }) {
  if (typeof openExternal !== 'function') throw oauthError('browser_open_unavailable');
  const pkce = createPkcePair();
  const state = crypto.randomBytes(32).toString('base64url');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    const onError = () => {
      server.removeListener('error', onError);
      reject(oauthError('loopback_bind_failed'));
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const authorizationUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge: pkce.challenge });
  const callback = waitForLoopbackCallback(server, redirectUri, state, timeoutMs);
  try {
    await openExternal(authorizationUrl.toString());
  } catch (error) {
    callback.cancel(oauthError('browser_open_failed'));
    throw oauthError('browser_open_failed');
  }
  const result = await callback.promise;
  return exchangeAuthorizationCode({ clientId, clientSecret, redirectUri, code: result.code, codeVerifier: pkce.verifier, fetchImpl });
}

module.exports = {
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  REVOKE_ENDPOINT,
  YOUTUBE_COMMENT_SCOPE,
  REFRESH_SKEW_MS,
  createPkcePair,
  buildAuthorizationUrl,
  authorizeDesktop,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  isAccessTokenUsable,
  assertLoopbackRedirect,
  waitForLoopbackCallback,
  oauthError,
};

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const {
  YOUTUBE_COMMENT_SCOPE,
  DEFAULT_YOUTUBE_OAUTH_CLIENT_ID,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  createPkcePair,
  buildAuthorizationUrl,
  authorizeDesktop,
  exchangeAuthorizationCode,
  refreshAccessToken,
  isAccessTokenUsable,
} = require('../src/core/youtube-auth.cjs');

test('the standalone app ships the existing public desktop client identifier', () => {
  assert.match(DEFAULT_YOUTUBE_OAUTH_CLIENT_ID, /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/);
});

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function tokenResponse(overrides = {}) {
  return {
    access_token: 'access-token-fixture',
    refresh_token: 'refresh-token-fixture',
    expires_in: 3600,
    scope: YOUTUBE_COMMENT_SCOPE,
    token_type: 'Bearer',
    ...overrides,
  };
}

test('PKCE uses a high-entropy verifier and the Google-recommended S256 challenge', () => {
  const pair = createPkcePair();
  assert.ok(pair.verifier.length >= 43 && pair.verifier.length <= 128);
  assert.match(pair.verifier, /^[A-Za-z0-9._~-]+$/);
  assert.equal(pair.challenge, crypto.createHash('sha256').update(pair.verifier, 'ascii').digest('base64url'));
  assert.equal(pair.challenge.includes('='), false);
});

test('YouTube authorization URL requests only the comment scope through a loopback callback', () => {
  const url = buildAuthorizationUrl({
    clientId: 'desktop-client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:43127',
    state: 'state-fixture',
    codeChallenge: 'challenge-fixture',
  });
  assert.equal(url.origin + url.pathname, AUTH_ENDPOINT);
  assert.equal(url.searchParams.get('client_id'), 'desktop-client.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:43127');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), YOUTUBE_COMMENT_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-fixture');
  assert.throws(() => buildAuthorizationUrl({
    clientId: 'desktop-client.apps.googleusercontent.com',
    redirectUri: 'https://attacker.example/callback',
    state: 'state-fixture',
    codeChallenge: 'challenge-fixture',
  }), /loopback/i);
});

test('desktop authorization validates the callback state before exchanging the code', async () => {
  let authorizationUrl;
  const result = await authorizeDesktop({
    clientId: 'desktop-client.apps.googleusercontent.com',
    openExternal: async (url) => {
      authorizationUrl = new URL(url);
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
      setImmediate(() => {
        http.get(`${redirectUri}?code=authorization-code-fixture&state=${authorizationUrl.searchParams.get('state')}`, (response) => response.resume());
      });
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, TOKEN_ENDPOINT);
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('code'), 'authorization-code-fixture');
      assert.equal(body.get('redirect_uri'), authorizationUrl.searchParams.get('redirect_uri'));
      assert.equal(body.get('code_verifier').length >= 43, true);
      return { ok: true, status: 200, json: async () => tokenResponse() };
    },
    timeoutMs: 2000,
  });
  assert.equal(result.accessToken, 'access-token-fixture');
  assert.equal(result.refreshToken, 'refresh-token-fixture');
  assert.deepEqual(result.grantedScopes, [YOUTUBE_COMMENT_SCOPE]);
});

test('authorization code exchange rejects a response without the required scope or refresh token', async () => {
  await assert.rejects(exchangeAuthorizationCode({
    clientId: 'desktop-client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:43127',
    code: 'code-fixture',
    codeVerifier: 'v'.repeat(64),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => tokenResponse({ scope: 'openid' }) }),
  }), (error) => error.code === 'required_scope_not_granted');

  await assert.rejects(exchangeAuthorizationCode({
    clientId: 'desktop-client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:43127',
    code: 'code-fixture',
    codeVerifier: 'v'.repeat(64),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => tokenResponse({ refresh_token: undefined }) }),
  }), (error) => error.code === 'refresh_token_missing');
});

test('refresh exchanges rotate the refresh token when Google returns a replacement', async () => {
  let requestBody;
  const result = await refreshAccessToken({
    clientId: 'desktop-client.apps.googleusercontent.com',
    refreshToken: 'old-refresh-token',
    previousScopes: [YOUTUBE_COMMENT_SCOPE],
    fetchImpl: async (url, options) => {
      assert.equal(url, TOKEN_ENDPOINT);
      requestBody = new URLSearchParams(options.body);
      return { ok: true, status: 200, json: async () => tokenResponse({ refresh_token: 'rotated-refresh-token', scope: undefined }) };
    },
  });
  assert.equal(requestBody.get('grant_type'), 'refresh_token');
  assert.equal(requestBody.get('refresh_token'), 'old-refresh-token');
  assert.equal(result.accessToken, 'access-token-fixture');
  assert.equal(result.refreshToken, 'rotated-refresh-token');
  assert.deepEqual(result.grantedScopes, [YOUTUBE_COMMENT_SCOPE]);
});

test('OAuth provider failures become stable non-secret codes', async () => {
  await assert.rejects(refreshAccessToken({
    clientId: 'desktop-client.apps.googleusercontent.com',
    refreshToken: 'refresh-token-that-must-not-appear',
    previousScopes: [YOUTUBE_COMMENT_SCOPE],
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'refresh-token-that-must-not-appear was revoked' }),
    }),
  }), (error) => {
    assert.equal(error.code, 'invalid_grant');
    assert.doesNotMatch(error.message, /refresh-token-that-must-not-appear/);
    return true;
  });
});

test('access-token readiness includes a refresh skew so expired tokens are refreshed before use', () => {
  assert.equal(isAccessTokenUsable({ accessToken: 'access', expiresAt: Date.now() + 120000 }), true);
  assert.equal(isAccessTokenUsable({ accessToken: 'access', expiresAt: Date.now() + 1000 }), false);
  assert.equal(isAccessTokenUsable({ accessToken: '', expiresAt: Date.now() + 120000 }), false);
});

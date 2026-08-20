const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  META_API_VERSION,
  DEFAULT_META_APP_ID,
  META_PERMISSIONS,
  authorizeMetaDesktop,
  buildMetaAuthorizationUrl,
  fetchManagedAccounts,
  normalizeManagedAccounts,
  normalizeMetaToken,
} = require('../src/core/meta-auth.cjs');
const {
  createInstagramContext,
  createFacebookContext,
  listFacebookMedia,
  executeInstagramAction,
  executeFacebookAction,
} = require('../src/core/meta.cjs');

test('the standalone app ships the existing public Meta App ID', () => {
  assert.match(DEFAULT_META_APP_ID, /^\d+$/);
});

test('Meta scopes match the configured Instagram API with Facebook login use case', () => {
  assert.deepEqual(new Set(META_PERMISSIONS), new Set([
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
  ]));
});

test('Meta authorization URL uses the pinned Graph version, loopback redirect, and community-care permissions', () => {
  const url = buildMetaAuthorizationUrl({
    appId: '12345',
    redirectUri: 'http://127.0.0.1:43210',
    state: 'state-value',
    codeChallenge: 'challenge-value',
  });
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, `/${META_API_VERSION}/dialog/oauth`);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:43210');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope').split(','), META_PERMISSIONS);
});

test('Meta desktop OAuth keeps the localhost redirect identical through callback and token exchange', async () => {
  let authorizationUrl;
  const tokenRequests = [];
  const result = await authorizeMetaDesktop({
    appId: '12345',
    appSecret: 'app-secret',
    openExternal: async (url) => {
      authorizationUrl = new URL(url);
      const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('code', 'authorization-code');
      callbackUrl.searchParams.set('state', authorizationUrl.searchParams.get('state'));
      http.get(callbackUrl, (response) => response.resume());
    },
    fetchImpl: async (url) => {
      tokenRequests.push(new URL(url));
      if (tokenRequests.length === 1) return new Response(JSON.stringify({ access_token: 'short-token', expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'long-token', expires_in: 3600 }), { status: 200 });
    },
  });
  const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
  assert.match(redirectUri, /^http:\/\/localhost:\d+\/$/);
  assert.equal(tokenRequests[0].searchParams.get('redirect_uri'), redirectUri);
  assert.equal(result.accessToken, 'long-token');
});

test('Meta token and managed-account normalization retains identities without exposing secrets to public records', () => {
  const token = normalizeMetaToken({ access_token: 'secret-token', token_type: 'bearer', expires_in: 3600, data_access_expiration_time: 123 });
  assert.equal(token.accessToken, 'secret-token');
  assert.ok(token.expiresAt > Date.now());
  const accounts = normalizeManagedAccounts({ data: [{ id: 'page-1', name: 'Page One', access_token: 'page-secret', tasks: ['MODERATE'], instagram_business_account: { id: 'ig-1' } }] });
  assert.deepEqual(accounts.map(({ platform, providerAccountId, displayName, capabilities }) => ({ platform, providerAccountId, displayName, capabilities })), [
    { platform: 'facebook', providerAccountId: 'page-1', displayName: 'Page One', capabilities: { comment: true, reply: true, webhook: true } },
    { platform: 'instagram', providerAccountId: 'ig-1', displayName: 'Page One · Instagram', capabilities: { comment: true, reply: true, webhook: true } },
  ]);
  assert.equal(accounts[0].accessToken, 'page-secret');
});

test('Meta managed-account discovery sends the user token as a bearer credential, never in the Graph URL', async () => {
  let request;
  const accounts = await fetchManagedAccounts({
    accessToken: 'user-secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ data: [{ id: 'page-1', name: 'Page One', access_token: 'page-secret', tasks: ['MODERATE'] }] }), { status: 200 });
    },
  });
  assert.doesNotMatch(request.url, /access_token=/i);
  assert.equal(request.options.headers.Authorization, 'Bearer user-secret');
  assert.equal(accounts[0].providerAccountId, 'page-1');
});

test('Meta actor capabilities fail closed when managed-account tasks are absent', () => {
  const accounts = normalizeManagedAccounts({ data: [{ id: 'page-without-tasks', name: 'Unproven Page', access_token: 'page-secret' }] });
  assert.deepEqual(accounts[0].capabilities, { comment: false, reply: false, webhook: false });
});

test('Facebook feed ownership is unknown when the provider omits the Page author identity', async () => {
  const rows = await listFacebookMedia({
    pageId: 'page-1',
    accessToken: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: 'owned-post', from: { id: 'page-1', name: 'Page One' }, message: 'Owned post' },
      { id: 'unresolved-post', message: 'Author omitted' },
    ] }), { status: 200 }),
  });
  assert.equal(rows.find((row) => row.targetId === 'owned-post').ownershipStatus, 'PROVIDER_LISTED_FOR_ACTOR');
  assert.equal(rows.find((row) => row.targetId === 'unresolved-post').ownershipStatus, 'OWNERSHIP_MISMATCH');
});

test('Instagram owned-media context and action use official Graph edges and exact read-back', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/ig-media-1?fields=')) {
      return new Response(JSON.stringify({ id: 'ig-media-1', caption: 'Rates retest', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/reel/ig-media-1', timestamp: '2026-08-20T00:00:00Z', username: 'marketlab' }), { status: 200 });
    }
    if (String(url).includes('/ig-media-1/comments?')) {
      return new Response(JSON.stringify({ data: [{ id: 'ig-comment-1', text: 'What confirms this?', username: 'viewer', timestamp: '2026-08-20T00:01:00Z' }] }), { status: 200 });
    }
    if (String(url).includes('/ig-comment-1/replies') && String(url).includes('fields=')) {
      return new Response(JSON.stringify({ data: [{ id: 'ig-reply-1', text: 'The retest is the useful confirmation.', username: 'marketlab', timestamp: '2026-08-20T00:02:00Z' }] }), { status: 200 });
    }
    if (String(url).endsWith('/ig-comment-1/replies')) {
      return new Response(JSON.stringify({ id: 'ig-reply-1' }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const context = await createInstagramContext({ mediaId: 'ig-media-1', actorAccountId: 'ig-1', ownershipProof: 'ig-1', ownedMedia: [{ targetId: 'ig-media-1', ownerAccountId: 'ig-1', ownershipStatus: 'PROVIDER_LISTED_FOR_ACTOR' }], accessToken: 'secret', fetchImpl });
  assert.equal(context.targetScope, 'owned');
  assert.equal(context.targetId, 'ig-media-1');
  assert.equal(context.comments[0].id, 'ig-comment-1');
  const result = await executeInstagramAction({ mediaId: 'ig-media-1', replyToId: 'ig-comment-1', actorAccountId: 'ig-1', text: 'The retest is the useful confirmation.', accessToken: 'secret', fetchImpl });
  assert.equal(result.providerId, 'ig-reply-1');
  assert.equal(result.exactText, 'The retest is the useful confirmation.');
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
});

test('Facebook Page context and action remain bound to the managed Page object', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/post-1?fields=')) return new Response(JSON.stringify({ id: 'post-1', message: 'Breadth retest', created_time: '2026-08-20T00:00:00Z', from: { id: 'page-1', name: 'Page One' }, permalink_url: 'https://facebook.com/post-1' }), { status: 200 });
    if (String(url).includes('/post-1/comments?')) return new Response(JSON.stringify({ data: [{ id: 'fb-comment-1', message: 'What is the invalidation?', from: { id: 'viewer' }, created_time: '2026-08-20T00:01:00Z' }] }), { status: 200 });
    if (String(url).includes('/fb-comment-1/comments') && String(url).includes('fields=')) return new Response(JSON.stringify({ data: [{ id: 'fb-reply-1', message: 'The invalidation is the useful test.', from: { id: 'page-1' }, created_time: '2026-08-20T00:02:00Z' }] }), { status: 200 });
    if (String(url).endsWith('/fb-comment-1/comments')) return new Response(JSON.stringify({ id: 'fb-reply-1' }), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  };
  const context = await createFacebookContext({ targetId: 'post-1', actorAccountId: 'page-1', ownershipProof: 'page-1', ownedMedia: [{ targetId: 'post-1', ownerAccountId: 'page-1', ownershipStatus: 'PROVIDER_LISTED_FOR_ACTOR' }], accessToken: 'secret', fetchImpl });
  assert.equal(context.channelId, 'page-1');
  const result = await executeFacebookAction({ targetId: 'post-1', replyToId: 'fb-comment-1', actorAccountId: 'page-1', text: 'The invalidation is the useful test.', accessToken: 'secret', fetchImpl });
  assert.equal(result.providerId, 'fb-reply-1');
  assert.equal(result.exactText, 'The invalidation is the useful test.');
  assert.ok(calls.every((call) => !call.url.includes('access_token=secret')));
});

test('Meta network failure after dispatch is treated as an ambiguous mutation', async () => {
  await assert.rejects(executeFacebookAction({
    targetId: 'post-1',
    replyToId: 'fb-comment-1',
    actorAccountId: 'page-1',
    text: 'The invalidation is the useful test.',
    accessToken: 'secret',
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') throw new Error('simulated network loss');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  }), (error) => error.mutationMayHaveOccurred === true && error.code === 'meta_network_error');
});

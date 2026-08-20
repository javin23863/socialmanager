const assert = require('node:assert/strict');
const test = require('node:test');
const { discoverVideos, reconcileYouTubeComment } = require('../src/core/youtube.cjs');

test('YouTube discovery can use the connected OAuth grant without a separate API key', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: new URL(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: { videoId: 'video-1' }, snippet: { channelId: 'channel-1', channelTitle: 'Trader', title: 'Market structure', description: 'A useful test' } }] }),
    };
  };
  try {
    const result = await discoverVideos({ query: 'market structure', accessToken: 'oauth-fixture', maxResults: 1 });
    assert.equal(result[0].videoId, 'video-1');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.searchParams.has('key'), false);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer oauth-fixture');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('YouTube reconciliation closes a provider text mismatch as a conclusive failure', async () => {
  const result = await reconcileYouTubeComment({
    commentId: 'comment-1',
    text: 'Approved copy',
    accessToken: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ items: [{ id: 'comment-1', snippet: { textOriginal: 'Different copy' } }] }), { status: 200 }),
  });
  assert.deepEqual(result, {
    exists: true,
    exact: false,
    providerId: 'comment-1',
    actualText: 'Different copy',
    reason: 'provider_text_mismatch',
  });
});

test('YouTube reconciliation treats an empty successful read-back as provider absence', async () => {
  const result = await reconcileYouTubeComment({
    commentId: 'comment-2',
    text: 'Approved copy',
    accessToken: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
  });
  assert.deepEqual(result, { exists: false, providerId: 'comment-2', reason: 'provider_not_found' });
});

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcileYouTubeComment } = require('../src/core/youtube.cjs');

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

const { sha256, normalizeText } = require('./engine.cjs');
const { parseTimedText } = require('./media-understanding.cjs');

const API_ROOT = 'https://www.googleapis.com/youtube/v3';

function apiError(operation, response, payload = {}) {
  const reason = normalizeText(payload?.error?.errors?.[0]?.reason || payload?.error?.status || payload?.error?.code);
  const error = new Error(`YouTube ${operation} ${response.status}${reason ? `:${reason}` : ''}`);
  error.code = 'youtube_api_error';
  error.httpStatus = response.status;
  error.authFailure = response.status === 401 || ['authError', 'insufficientPermissions', 'unauthorized'].includes(reason);
  return error;
}

function parseVideoId(input) {
  const raw = normalizeText(input);
  if (/^[a-zA-Z0-9_-]{6,20}$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error('Enter a valid YouTube URL or video ID');
  }
  if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error('URL is not a YouTube URL');
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const parts = url.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1];
  throw new Error('Could not find a video ID in the YouTube URL');
}

async function apiGet(path, params, apiKey) {
  const url = new URL(`${API_ROOT}/${path}`);
  Object.entries({ ...params, key: apiKey }).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw apiError('API request failed', response, payload);
  return payload;
}

async function discoverVideos({ query, apiKey, maxResults = 12, publishedAfter }) {
  if (!apiKey) throw new Error('YouTube Data API key is not configured');
  const cleanQuery = normalizeText(query);
  if (!cleanQuery) throw new Error('A niche discovery query is required');
  const payload = await apiGet('search', {
    part: 'snippet',
    q: cleanQuery,
    type: 'video',
    order: 'relevance',
    safeSearch: 'strict',
    maxResults: Math.min(25, Math.max(1, maxResults)),
    ...(publishedAfter ? { publishedAfter } : {}),
  }, apiKey);
  return (payload.items || []).map((item) => ({
    platform: 'youtube',
    videoId: item.id?.videoId || '',
    channelId: item.snippet?.channelId || '',
    account: item.snippet?.channelTitle || '',
    title: normalizeText(item.snippet?.title),
    description: normalizeText(item.snippet?.description),
    publishedAt: item.snippet?.publishedAt || '',
    url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
  })).filter((item) => item.videoId && item.url);
}

async function apiGetAuthorized(path, params, accessToken) {
  if (!accessToken) throw new Error('YouTube OAuth access token is not configured');
  const url = new URL(`${API_ROOT}/${path}`);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw apiError('authorized API request failed', response, payload);
  return payload;
}

async function fetchAuthorizedTranscript({ videoId, accessToken }) {
  if (!accessToken) return { text: '', segments: [], transcriptProvenance: null, status: 'oauth_not_configured', source: null };
  const payload = await apiGetAuthorized('captions', { part: 'id,snippet', videoId }, accessToken);
  const tracks = Array.isArray(payload.items) ? payload.items : [];
  const track = tracks.find((item) => item.snippet?.trackKind !== 'ASR') || tracks[0];
  if (!track?.id) return { text: '', segments: [], transcriptProvenance: null, status: 'no_authorized_caption_track', source: null };
  const url = new URL(`${API_ROOT}/captions/${encodeURIComponent(track.id)}`);
  url.searchParams.set('tfmt', 'vtt');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const raw = await response.text();
  if (!response.ok) throw apiError('caption download failed', response);
  const sourceId = `youtube_caption_track:${track.id}`;
  const segments = parseTimedText(raw, { sourceId, format: 'vtt' });
  const text = (segments.length ? segments.map((segment) => segment.text).join(' ') : normalizeText(raw)).slice(0, 24000);
  return {
    text,
    segments,
    transcriptProvenance: { kind: 'youtube_caption_track', trackId: track.id, sourceId, language: track.snippet?.language || '' },
    status: 'authorized_caption_track',
    source: `youtube_data_api:captions:${track.id}`,
    trackId: track.id,
    language: track.snippet?.language || '',
  };
}

async function fetchAuthorizedChannel({ accessToken }) {
  const payload = await apiGetAuthorized('channels', { part: 'id,snippet', mine: 'true' }, accessToken);
  const channel = payload.items?.[0];
  if (!channel?.id) {
    const error = new Error('YouTube OAuth did not return the connected channel identity');
    error.code = 'youtube_actor_identity_missing';
    throw error;
  }
  return {
    providerAccountId: String(channel.id),
    displayName: normalizeText(channel.snippet?.title || channel.id),
    capabilities: { comment: true, reply: true, readBack: true },
  };
}

async function fetchContext({ url, apiKey, accessToken, maxComments = 20 }) {
  if (!apiKey) throw new Error('YouTube Data API key is not configured');
  const videoId = parseVideoId(url);
  const payload = await apiGet('videos', { part: 'snippet,contentDetails,statistics', id: videoId }, apiKey);
  const video = payload.items?.[0];
  if (!video) throw new Error('YouTube video was not found or is not public');
  let comments = [];
  let commentStatus = 'available';
  try {
    const commentPayload = await apiGet('commentThreads', {
      part: 'snippet,replies', videoId, maxResults: Math.min(100, Math.max(1, maxComments)), order: 'relevance', textFormat: 'plainText',
    }, apiKey);
    comments = (commentPayload.items || []).map((item) => {
      const snippet = item.snippet?.topLevelComment?.snippet || {};
      return { id: item.snippet?.topLevelComment?.id || item.id || '', text: normalizeText(snippet.textOriginal || snippet.textDisplay), likes: Number(snippet.likeCount || 0), publishedAt: snippet.publishedAt || '' };
    }).filter((comment) => comment.text);
  } catch (error) {
    comments = [];
    commentStatus = `unavailable:${error.message}`;
  }
  let transcript = '';
  let transcriptSegments = [];
  let transcriptProvenance = null;
  let captionStatus = 'oauth_not_configured';
  let captionSource = null;
  try {
    const caption = await fetchAuthorizedTranscript({ videoId, accessToken });
    transcript = caption.text;
    transcriptSegments = Array.isArray(caption.segments) ? caption.segments : [];
    transcriptProvenance = caption.transcriptProvenance || null;
    captionStatus = caption.status;
    captionSource = caption.source;
  } catch (error) {
    captionStatus = `caption_unavailable:${error.message}`;
  }
  const snippet = video.snippet || {};
  const statistics = video.statistics || {};
  return {
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    channelId: snippet.channelId || '',
    account: snippet.channelTitle || '',
    title: snippet.title || '',
    description: (snippet.description || '').slice(0, 12000),
    transcript,
    transcriptSource: captionSource,
    transcriptSegments,
    transcriptProvenance,
    visualNotes: '',
    visualObservations: [],
    visualStatus: 'not_authorized',
    mediaProvenance: { kind: 'youtube_data_api', sourceId: `youtube_data_api:videos:${videoId}` },
    authorizedMediaStatus: transcriptSegments.length ? 'AUTHORIZED_CAPTIONS_ONLY' : 'PUBLIC_METADATA_ONLY',
    comments,
    publishedAt: snippet.publishedAt || '',
    views: Number(statistics.viewCount || 0),
    likes: Number(statistics.likeCount || 0),
    commentCount: Number(statistics.commentCount || 0),
    duration: video.contentDetails?.duration || '',
    contextSources: ['youtube_data_api:videos', ...(commentStatus === 'available' ? ['youtube_data_api:commentThreads'] : []), ...(captionSource ? [captionSource] : [])],
    commentStatus,
    captionStatus,
    contextFingerprint: sha256(JSON.stringify({ videoId, title: snippet.title, description: snippet.description, comments })),
  };
}

async function apiWrite(path, params, body, accessToken) {
  if (!accessToken) throw new Error('YouTube OAuth access token is not configured');
  const url = new URL(`${API_ROOT}/${path}`);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw apiError('write failed', response, payload);
  return payload;
}

async function readBackComment(commentId, text, accessToken, fetchImpl = globalThis.fetch) {
  const url = new URL(`${API_ROOT}/comments`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', commentId);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw apiError('comment read-back failed', response, payload);
  const item = payload.items?.[0];
  if (!item) {
    const error = new Error('YouTube comment read-back did not return the provider object');
    error.code = 'youtube_comment_not_found';
    error.httpStatus = 404;
    error.providerId = commentId;
    throw error;
  }
  const actual = item.snippet?.textOriginal || '';
  if (actual !== text) {
    const error = new Error('YouTube comment read-back did not match exact approved text');
    error.code = 'youtube_readback_mismatch';
    error.actualText = actual;
    error.providerId = commentId;
    throw error;
  }
  return { providerId: commentId, exactText: actual, verifiedAt: new Date().toISOString() };
}

async function executeComment({ videoId, channelId, text, accessToken }) {
  let payload;
  try {
    payload = await apiWrite('commentThreads', { part: 'snippet' }, {
      snippet: {
        channelId,
        videoId,
        topLevelComment: { snippet: { textOriginal: text } },
      },
    }, accessToken);
  } catch (error) {
    const status = Number(error.httpStatus || /^YouTube write failed (\d{3})/.exec(String(error.message || ''))?.[1] || 0);
    error.mutationMayHaveOccurred = !status || status >= 500;
    throw error;
  }
  const commentId = payload.snippet?.topLevelComment?.id || payload.id;
  if (!commentId) {
    const error = new Error('YouTube accepted the write but did not return a comment ID');
    error.code = 'youtube_provider_id_missing';
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  try {
    return await readBackComment(commentId, text, accessToken);
  } catch (error) {
    error.mutationMayHaveOccurred = true;
    error.providerId = commentId;
    throw error;
  }
}

async function executeReply({ parentId, text, accessToken }) {
  if (!parentId) throw new Error('YouTube reply target is not configured');
  let payload;
  try {
    payload = await apiWrite('comments', { part: 'snippet' }, {
      snippet: { parentId, textOriginal: text },
    }, accessToken);
  } catch (error) {
    const status = Number(error.httpStatus || /^YouTube write failed (\d{3})/.exec(String(error.message || ''))?.[1] || 0);
    error.mutationMayHaveOccurred = !status || status >= 500;
    throw error;
  }
  const commentId = payload.id || payload.snippet?.id;
  if (!commentId) {
    const error = new Error('YouTube accepted the reply but did not return a comment ID');
    error.code = 'youtube_provider_id_missing';
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  try {
    return await readBackComment(commentId, text, accessToken);
  } catch (error) {
    error.mutationMayHaveOccurred = true;
    error.providerId = commentId;
    throw error;
  }
}

async function reconcileYouTubeComment({ commentId, text, accessToken, fetchImpl = globalThis.fetch }) {
  if (!commentId) throw new Error('YouTube provider comment ID is required for reconciliation');
  try {
    const readBack = await readBackComment(commentId, text, accessToken, fetchImpl);
    return { exists: true, exact: true, ...readBack };
  } catch (error) {
    if (Number(error.httpStatus) === 404 || error.code === 'youtube_comment_not_found') return { exists: false, providerId: commentId, reason: 'provider_not_found' };
    if (error.code === 'youtube_readback_mismatch') return { exists: true, exact: false, providerId: commentId, actualText: error.actualText || '', reason: 'provider_text_mismatch' };
    throw error;
  }
}

module.exports = { parseVideoId, discoverVideos, fetchContext, fetchAuthorizedTranscript, fetchAuthorizedChannel, executeComment, executeReply, reconcileYouTubeComment };

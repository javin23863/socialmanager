const { sha256, normalizeText } = require('./engine.cjs');

const API_ROOT = 'https://www.googleapis.com/youtube/v3';

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
  if (!response.ok || payload.error) throw new Error(`YouTube API ${response.status}: ${payload.error?.message || 'request failed'}`);
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
  if (!response.ok || payload.error) throw new Error(`YouTube authorized API ${response.status}: ${payload.error?.message || 'request failed'}`);
  return payload;
}

async function fetchAuthorizedTranscript({ videoId, accessToken }) {
  if (!accessToken) return { text: '', status: 'oauth_not_configured', source: null };
  const payload = await apiGetAuthorized('captions', { part: 'id,snippet', videoId }, accessToken);
  const tracks = Array.isArray(payload.items) ? payload.items : [];
  const track = tracks.find((item) => item.snippet?.trackKind !== 'ASR') || tracks[0];
  if (!track?.id) return { text: '', status: 'no_authorized_caption_track', source: null };
  const url = new URL(`${API_ROOT}/captions/${encodeURIComponent(track.id)}`);
  url.searchParams.set('tfmt', 'txt');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`YouTube caption download ${response.status}: ${raw.slice(0, 180)}`);
  return {
    text: normalizeText(raw).slice(0, 24000),
    status: 'authorized_caption_track',
    source: `youtube_data_api:captions:${track.id}`,
    trackId: track.id,
    language: track.snippet?.language || '',
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
  let captionStatus = 'oauth_not_configured';
  let captionSource = null;
  try {
    const caption = await fetchAuthorizedTranscript({ videoId, accessToken });
    transcript = caption.text;
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
    visualNotes: '',
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
  if (!response.ok || payload.error) throw new Error(`YouTube write ${response.status}: ${payload.error?.message || 'request failed'}`);
  return payload;
}

async function readBackComment(commentId, text, accessToken) {
  const url = new URL(`${API_ROOT}/comments`);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('id', commentId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(`YouTube comment read-back ${response.status}: ${payload.error?.message || 'request failed'}`);
  const actual = payload.items?.[0]?.snippet?.textOriginal || '';
  if (actual !== text) throw new Error('YouTube comment read-back did not match exact approved text');
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
    const status = Number(/^YouTube write (\d{3}):/.exec(String(error.message || ''))?.[1] || 0);
    error.mutationMayHaveOccurred = !status || status >= 500;
    throw error;
  }
  const commentId = payload.snippet?.topLevelComment?.id || payload.id;
  if (!commentId) {
    const error = new Error('YouTube accepted the write but did not return a comment ID');
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

module.exports = { parseVideoId, discoverVideos, fetchContext, fetchAuthorizedTranscript, executeComment };

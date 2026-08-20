const { graphUrl, META_API_VERSION, metaError, version } = require('./meta-auth.cjs');

function apiError(operation, response, payload = {}) {
  const errorCode = String(payload?.error?.code || payload?.error?.type || '').toLowerCase();
  const error = new Error(`Meta ${operation} ${response.status}${errorCode ? `:${errorCode}` : ''}`);
  error.code = 'meta_api_error';
  error.httpStatus = response.status;
  error.authFailure = response.status === 401 || [190, 200, 10].includes(Number(payload?.error?.code)) || /oauth|permission|token|auth/.test(errorCode);
  return error;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

async function graphRequest({ apiVersion = META_API_VERSION, path, params = {}, accessToken, method = 'GET', body = null, fetchImpl = globalThis.fetch, operation = 'request' } = {}) {
  if (!String(accessToken || '').trim()) throw new Error('Meta access token is not configured');
  if (typeof fetchImpl !== 'function') throw new Error('This runtime does not provide fetch');
  const url = graphUrl(apiVersion, path, params);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${String(accessToken)}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    });
  } catch (error) {
    const network = new Error(`Meta ${operation} network error`);
    network.code = 'meta_network_error';
    throw network;
  }
  const payload = await readJson(response);
  if (!response.ok || payload.error) throw apiError(operation, response, payload);
  return payload;
}

function requireId(value, code = 'provider_id_required') {
  const id = String(value || '').trim();
  if (!id) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return id;
}

function normalizeComments(items, platform) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || '').trim(),
    text: String(item?.text ?? item?.message ?? '').replace(/\s+/g, ' ').trim(),
    account: String(item?.username || item?.from?.name || '').trim(),
    accountId: String(item?.from?.id || '').trim(),
    publishedAt: String(item?.timestamp || item?.created_time || '').trim(),
    likes: Number(item?.like_count || 0),
    platform,
  })).filter((comment) => comment.id && comment.text);
}

async function listInstagramMedia({ actorAccountId, accessToken, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch, limit = 25 } = {}) {
  const actor = requireId(actorAccountId, 'instagram_actor_account_required');
  const payload = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(actor)}/media`,
    params: { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,username,like_count,comments_count', limit: Math.min(100, Math.max(1, Number(limit) || 25)) },
    accessToken,
    fetchImpl,
    operation: 'Instagram media list',
  });
  return (Array.isArray(payload.data) ? payload.data : []).map((item) => ({
    platform: 'instagram',
    targetId: String(item.id || '').trim(),
    ownerAccountId: actor,
    channelId: actor,
    account: String(item.username || actor).trim(),
    title: String(item.caption || '').split(/\r?\n/)[0].trim(),
    description: String(item.caption || '').trim(),
    url: String(item.permalink || '').trim(),
    publishedAt: String(item.timestamp || '').trim(),
    mediaType: String(item.media_type || '').trim(),
    mediaProductType: String(item.media_product_type || '').trim(),
    metrics: {
      likeCount: Number(item.like_count || 0),
      commentCount: Number(item.comments_count || 0),
      source: 'meta_api:instagram_media',
    },
    ownershipStatus: 'PROVIDER_LISTED_FOR_ACTOR',
  })).filter((item) => item.targetId);
}

async function createInstagramContext({ mediaId, actorAccountId, accessToken, ownershipProof = '', ownedMedia = null, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch, maxComments = 20 } = {}) {
  const targetId = requireId(mediaId, 'instagram_media_id_required');
  const actor = requireId(actorAccountId, 'instagram_actor_account_required');
  const ownershipBound = Array.isArray(ownedMedia)
    && ownedMedia.some((item) => String(item?.targetId || '') === targetId && String(item?.ownerAccountId || '') === actor && item?.ownershipStatus === 'PROVIDER_LISTED_FOR_ACTOR');
  const media = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(targetId)}`,
    params: { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,username,like_count,comments_count' },
    accessToken,
    fetchImpl,
    operation: 'Instagram media context',
  });
  const comments = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(targetId)}/comments`,
    params: { fields: 'id,text,username,timestamp,like_count', limit: Math.min(100, Math.max(1, Number(maxComments) || 20)) },
    accessToken,
    fetchImpl,
    operation: 'Instagram comment context',
  });
  return {
    platform: 'instagram',
    targetScope: 'owned',
    action: 'reply',
    url: String(media.permalink || `https://instagram.com/${targetId}`).trim(),
    targetId,
    videoId: targetId,
    channelId: actor,
    account: String(media.username || actor).trim(),
    title: String(media.caption || '').split(/\r?\n/)[0].trim(),
    description: String(media.caption || '').trim(),
    transcript: '',
    visualNotes: '',
    comments: normalizeComments(comments.data, 'instagram'),
    publishedAt: String(media.timestamp || '').trim(),
    mediaType: String(media.media_type || '').trim(),
    mediaProductType: String(media.media_product_type || '').trim(),
    metrics: {
      likeCount: Number(media.like_count || 0),
      commentCount: Number(media.comments_count || comments.data?.length || 0),
      source: 'meta_api:instagram_media',
    },
    ownershipStatus: ownershipBound && String(ownershipProof || '') === actor ? 'PROVIDER_LISTED_FOR_ACTOR' : 'OWNERSHIP_PROOF_REQUIRED',
    contextSources: ['meta_api:instagram_media', 'meta_api:instagram_comments'],
    captionStatus: 'provider_caption',
    visualStatus: 'not_authorized',
  };
}

async function listFacebookMedia({ pageId, accessToken, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch, limit = 25 } = {}) {
  const actor = requireId(pageId, 'facebook_page_id_required');
  const payload = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(actor)}/feed`,
    params: { fields: 'id,message,created_time,from,permalink_url,likes.summary(true),comments.summary(true)', limit: Math.min(100, Math.max(1, Number(limit) || 25)) },
    accessToken,
    fetchImpl,
    operation: 'Facebook Page media list',
  });
  return (Array.isArray(payload.data) ? payload.data : []).map((item) => ({
    platform: 'facebook',
    targetId: String(item.id || '').trim(),
    ownerAccountId: actor,
    channelId: actor,
    account: String(item.from?.name || actor).trim(),
    title: String(item.message || '').split(/\r?\n/)[0].trim(),
    description: String(item.message || '').trim(),
    url: String(item.permalink_url || '').trim(),
    publishedAt: String(item.created_time || '').trim(),
    metrics: {
      likeCount: Number(item.likes?.summary?.total_count || 0),
      commentCount: Number(item.comments?.summary?.total_count || 0),
      source: 'meta_api:facebook_page_feed',
    },
    ownershipStatus: String(item.from?.id || '').trim() === actor ? 'PROVIDER_LISTED_FOR_ACTOR' : 'OWNERSHIP_MISMATCH',
  })).filter((item) => item.targetId);
}

async function createFacebookContext({ targetId, actorAccountId, accessToken, ownershipProof = '', ownedMedia = null, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch, maxComments = 20 } = {}) {
  const objectId = requireId(targetId, 'facebook_target_id_required');
  const actor = requireId(actorAccountId, 'facebook_page_id_required');
  const ownershipBound = Array.isArray(ownedMedia)
    && ownedMedia.some((item) => String(item?.targetId || '') === objectId && String(item?.ownerAccountId || '') === actor && item?.ownershipStatus === 'PROVIDER_LISTED_FOR_ACTOR');
  const media = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(objectId)}`,
    params: { fields: 'id,message,created_time,from,permalink_url,likes.summary(true),comments.summary(true)' },
    accessToken,
    fetchImpl,
    operation: 'Facebook Page media context',
  });
  const ownerId = String(media.from?.id || '').trim();
  if (ownerId && ownerId !== actor) {
    const error = new Error('Facebook target is not owned by the connected Page actor');
    error.code = 'facebook_ownership_mismatch';
    throw error;
  }
  if (!ownershipBound || String(ownershipProof || '') !== actor) {
    const error = new Error('Facebook target was not present in the provider-owned Page feed');
    error.code = 'facebook_ownership_proof_required';
    throw error;
  }
  const comments = await graphRequest({
    apiVersion,
    path: `/${encodeURIComponent(objectId)}/comments`,
    params: { fields: 'id,message,from,created_time,like_count', limit: Math.min(100, Math.max(1, Number(maxComments) || 20)), filter: 'stream' },
    accessToken,
    fetchImpl,
    operation: 'Facebook comment context',
  });
  const ownershipStatus = 'PROVIDER_LISTED_FOR_ACTOR';
  return {
    platform: 'facebook',
    targetScope: 'owned',
    action: 'reply',
    url: String(media.permalink_url || '').trim() || `https://facebook.com/${objectId}`,
    targetId: objectId,
    videoId: objectId,
    channelId: actor,
    account: String(media.from?.name || actor).trim(),
    title: String(media.message || '').split(/\r?\n/)[0].trim(),
    description: String(media.message || '').trim(),
    transcript: '',
    visualNotes: '',
    comments: normalizeComments(comments.data, 'facebook'),
    publishedAt: String(media.created_time || '').trim(),
    metrics: {
      likeCount: Number(media.likes?.summary?.total_count || 0),
      commentCount: Number(media.comments?.summary?.total_count || comments.data?.length || 0),
      source: 'meta_api:facebook_page_feed',
    },
    ownershipStatus,
    contextSources: ['meta_api:facebook_page_media', 'meta_api:facebook_comments'],
    captionStatus: 'provider_caption',
    visualStatus: 'not_authorized',
  };
}

async function readBackFromEdge({ edgePath, providerId, text, actorAccountId, platform, apiVersion, accessToken, fetchImpl, operation }) {
  const fields = platform === 'instagram' ? 'id,text,username,timestamp' : 'id,message,from,created_time';
  const payload = await graphRequest({
    apiVersion,
    path: edgePath,
    params: { fields },
    accessToken,
    fetchImpl,
    operation: `${operation} read-back`,
  });
  const candidates = Array.isArray(payload.data) ? payload.data : payload.id ? [payload] : [];
  const readBack = candidates.find((item) => String(item?.id || '') === String(providerId)) || null;
  if (!readBack) {
    const error = new Error(`Meta ${operation} read-back did not return the provider object`);
    error.code = 'meta_readback_missing';
    error.providerId = providerId;
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  if (actorAccountId && readBack.from?.id && String(readBack.from.id) !== String(actorAccountId)) {
    const error = new Error(`Meta ${operation} read-back was not authored by the connected actor`);
    error.code = 'meta_readback_actor_mismatch';
    error.providerId = providerId;
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  const actual = String(readBack.text ?? readBack.message ?? '').replace(/\s+/g, ' ').trim();
  if (actual !== String(text).replace(/\s+/g, ' ').trim()) {
    const error = new Error(`Meta ${operation} exact read-back mismatch`);
    error.code = 'meta_readback_mismatch';
    error.providerId = providerId;
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  return { providerId, exactText: actual, authoredBy: readBack.from?.id || readBack.username || null, verifiedAt: new Date().toISOString() };
}

async function writeAndReadBack({ targetPath, readBackPath, text, actorAccountId, platform, accessToken, apiVersion, fetchImpl, operation }) {
  let created;
  try {
    created = await graphRequest({
      apiVersion,
      path: targetPath,
      accessToken,
      method: 'POST',
      body: { message: text },
      fetchImpl,
      operation,
    });
  } catch (error) {
    const status = Number(error.httpStatus || 0);
    if (error.code === 'meta_network_error' || status === 0 || status >= 500) error.mutationMayHaveOccurred = true;
    throw error;
  }
  const providerId = String(created.id || '').trim();
  if (!providerId) {
    const error = new Error(`Meta ${operation} accepted the write without returning a provider ID`);
    error.code = 'meta_provider_id_missing';
    error.mutationMayHaveOccurred = true;
    throw error;
  }
  try {
    return await readBackFromEdge({
      edgePath: readBackPath(providerId),
      providerId,
      text,
      actorAccountId,
      platform,
      apiVersion,
      accessToken,
      fetchImpl,
      operation,
    });
  } catch (error) {
    error.providerId = error.providerId || providerId;
    error.mutationMayHaveOccurred = true;
    throw error;
  }
}

async function executeInstagramAction({ mediaId, replyToId, actorAccountId, text, accessToken, action = 'reply', apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch } = {}) {
  if (action !== 'reply') {
    const error = new Error('Instagram owned care is reply-only in this product contract');
    error.code = 'instagram_reply_only';
    throw error;
  }
  const parentId = action === 'reply' ? requireId(replyToId, 'instagram_reply_target_required') : requireId(mediaId, 'instagram_media_id_required');
  const path = action === 'reply' ? `/${encodeURIComponent(parentId)}/replies` : `/${encodeURIComponent(parentId)}/comments`;
  return writeAndReadBack({ targetPath: path, readBackPath: () => path, text, actorAccountId, platform: 'instagram', accessToken, apiVersion, fetchImpl, operation: `Instagram ${action}` });
}

async function executeFacebookAction({ targetId, replyToId, actorAccountId, text, accessToken, action = 'reply', apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch } = {}) {
  const parentId = action === 'reply' ? requireId(replyToId, 'facebook_reply_target_required') : requireId(targetId, 'facebook_target_id_required');
  const path = action === 'reply' ? `/${encodeURIComponent(parentId)}/comments` : `/${encodeURIComponent(parentId)}/comments`;
  return writeAndReadBack({ targetPath: path, readBackPath: () => path, text, actorAccountId, platform: 'facebook', accessToken, apiVersion, fetchImpl, operation: `Facebook ${action}` });
}

async function reconcileMetaAction({ providerId, text, platform, actorAccountId, accessToken, apiVersion = META_API_VERSION, fetchImpl = globalThis.fetch } = {}) {
  const id = requireId(providerId, 'provider_id_required');
  try {
    const fields = platform === 'instagram' ? 'id,text,username,timestamp' : 'id,message,from,created_time';
    const payload = await graphRequest({ apiVersion, path: `/${encodeURIComponent(id)}`, params: { fields }, accessToken, fetchImpl, operation: `${platform} reconciliation` });
    if (actorAccountId && payload.from?.id && String(payload.from.id) !== String(actorAccountId)) return { exists: true, exact: false, providerId: id, reason: 'provider_actor_mismatch', authoredBy: payload.from.id };
    const actual = String(payload.text ?? payload.message ?? '').replace(/\s+/g, ' ').trim();
    if (actual !== String(text || '').replace(/\s+/g, ' ').trim()) return { exists: true, exact: false, providerId: id, actualText: actual };
    return { exists: true, exact: true, providerId: id, exactText: actual, verifiedAt: new Date().toISOString() };
  } catch (error) {
    if (Number(error.httpStatus) === 404) return { exists: false, providerId: id, reason: 'provider_not_found' };
    throw error;
  }
}

module.exports = {
  graphRequest,
  listInstagramMedia,
  createInstagramContext,
  listFacebookMedia,
  createFacebookContext,
  executeInstagramAction,
  executeFacebookAction,
  reconcileMetaAction,
  apiError,
  version,
};

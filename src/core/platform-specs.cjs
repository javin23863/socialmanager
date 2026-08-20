const SNAPSHOT_DATE = '2026-08-20';

/*
 * This file is deliberately declarative. A provider adapter may only expose an
 * action that is listed here. Numeric values carry their source confidence so
 * an undocumented limit cannot quietly become a hard platform fact.
 */
const PLATFORM_SPECS = {
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    officialRoute: 'YouTube Data API v3',
    discovery: 'Video metadata, public comments, and authorized caption tracks',
    context: 'metadata + public comments; captions require an authorized track',
    status: 'ready_with_oauth',
    sourceUrls: [
      'https://developers.google.com/youtube/v3/docs',
      'https://developers.google.com/youtube/v3/guides/implementation/comments',
      'https://developers.google.com/youtube/v3/docs/commentThreads/insert',
      'https://support.google.com/youtube/answer/2801973',
      'https://support.google.com/youtube/answer/3399767',
      'https://support.google.com/youtube/answer/15424877',
    ],
    actions: {
      comment: { external: true, owned: true, route: 'commentThreads.insert + comments.list read-back' },
      reply: { external: true, owned: true, route: 'comments.insert + comments.list read-back' },
      like: { external: false, owned: false, route: null, reason: 'Product policy blocks automated rating/like farming.' },
    },
    commentStyle: 'Specific source observation + a test or invalidation question; conversational but evidence-dense.',
    surfaces: {
      comment: {
        platformMaxChars: null,
        platformMaxLabel: 'Provider-enforced; numeric maximum is not published in the reviewed official API docs',
        qualityMaxChars: 600,
        qualityMaxSource: 'studio_policy',
      },
      title: { platformMaxChars: 100, platformMaxSource: 'official', platformMaxLabel: 'YouTube Help / API requirements' },
      description: { platformMaxChars: 5000, platformMaxSource: 'official', platformMaxLabel: 'YouTube Help / API requirements' },
      video: {
        formats: ['MP4', 'H.264', 'AAC'],
        shortForm: 'square or vertical, up to 3 minutes',
        shortFormSource: 'official',
      },
    },
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    officialRoute: 'Meta Graph API / Instagram API',
    discovery: 'Professional-account media and managed comments',
    context: 'owned professional media and comments; external discovery is not a proven write route',
    status: 'owned_surface_only',
    sourceUrls: [
      'https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api',
      'https://www.facebook.com/help/instagram/138925576505882',
      'https://www.facebook.com/help/instagram/1038071743007909',
      'https://www.facebook.com/help/instagram/728994388226960',
      'https://www.facebook.com/legal/automated_data_collection_terms',
      'https://www.facebook.com/legal/terms',
    ],
    actions: {
      comment: { external: false, owned: true, route: 'managed professional-media comments only' },
      reply: { external: false, owned: true, route: 'managed professional-media comments only' },
      like: { external: false, owned: false, route: null, reason: 'No reviewed official route for proactive external likes.' },
    },
    commentStyle: 'Short visual or spoken detail + one sharp question; comments are community care on connected professional media.',
    surfaces: {
      comment: {
        platformMaxChars: null,
        platformMaxLabel: 'Not published in the reviewed official docs',
        qualityMaxChars: 600,
        qualityMaxSource: 'studio_policy',
      },
      caption: {
        platformMaxChars: 2200,
        platformMaxSource: 'house_reference_needs_day_of_verification',
        platformMaxLabel: 'House publishing reference; verify against Instagram on the day of a critical publish',
      },
      bio: { platformMaxChars: 150, platformMaxSource: 'official_help' },
      video: {
        aspectRatio: '1.91:1 to 9:16',
        minimumResolution: '720px',
        minimumFrameRate: '30fps',
        shortForm: 'Reels-first; organic duration is subject to current account/app rules',
        shortFormSource: 'official_help_plus_house_reference',
      },
    },
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook',
    officialRoute: 'Meta Graph API / Page-managed surfaces',
    discovery: 'Page-owned media and managed comments',
    context: 'owned Page/profile media and managed comments; external proactive write route is not proven',
    status: 'owned_surface_only',
    sourceUrls: [
      'https://developers.facebook.com/docs/graph-api/',
      'https://www.facebook.com/help/772447486244207',
      'https://www.facebook.com/help/121317464722113',
      'https://www.facebook.com/help/www/2862139500770200',
      'https://www.facebook.com/legal/automated_data_collection_terms',
      'https://www.facebook.com/legal/terms',
    ],
    actions: {
      comment: { external: false, owned: true, route: 'Page-managed comments only; exact endpoint depends on Page asset type' },
      reply: { external: false, owned: true, route: 'Page-managed comments only' },
      like: { external: false, owned: false, route: null, reason: 'No reviewed official route for proactive external likes.' },
    },
    commentStyle: 'Plain-language observation + practical question; Page-managed conversation only.',
    surfaces: {
      comment: {
        platformMaxChars: null,
        platformMaxLabel: 'Not published in the reviewed official docs',
        qualityMaxChars: 600,
        qualityMaxSource: 'studio_policy',
      },
      caption: {
        platformMaxChars: null,
        platformMaxLabel: 'Not published in the reviewed official docs',
        qualityMaxChars: 5000,
        qualityMaxSource: 'studio_policy',
      },
      video: {
        formats: ['MP4', 'MOV'],
        maxDurationMinutes: 240,
        maxFileSizeGB: 4,
        source: 'official_help',
        reelsNote: 'Facebook Help currently describes Reels as up to 90 seconds while also documenting a transition to broader video-as-Reels handling; verify the target Page surface at publish time.',
      },
    },
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    officialRoute: 'Content Posting API / Research API',
    discovery: 'Own-account publishing; approved Research API for delayed public research data',
    context: 'public research data only where an eligible Research API account is approved',
    status: 'read_only_external',
    sourceUrls: [
      'https://developers.tiktok.com/doc/content-posting-api-get-started',
      'https://developers.tiktok.com/doc/content-posting-api-reference-direct-post',
      'https://developers.tiktok.com/doc/about-research-api',
      'https://developers.tiktok.com/doc/research-api-specs-query-video-comments',
      'https://developers.tiktok.com/doc/research-api-faq',
      'https://support.tiktok.com/en/using-tiktok/creating-videos/creator-tools-on-tiktok',
      'https://support.tiktok.com/en/using-tiktok/messaging-and-notifications/comments',
    ],
    actions: {
      comment: { external: false, owned: false, route: null, reason: 'Reviewed official routes do not provide general external comment mutation.' },
      reply: { external: false, owned: false, route: null, reason: 'Reviewed official routes do not provide general comment-reply mutation.' },
      like: { external: false, owned: false, route: null, reason: 'No reviewed official route for proactive external likes.' },
    },
    commentStyle: 'Brief, punchy source detail + one clear question; this is a research/read-only contract for external targets.',
    surfaces: {
      comment: {
        platformMaxChars: null,
        platformMaxLabel: 'Not published in the reviewed official docs',
        qualityMaxChars: 240,
        qualityMaxSource: 'studio_policy',
      },
      caption: {
        platformMaxChars: 4000,
        platformMaxSource: 'house_reference_needs_day_of_verification',
        platformMaxLabel: 'House publishing reference; verify against TikTok on the day of a critical publish',
      },
      bio: { platformMaxChars: 80, platformMaxSource: 'house_reference_needs_day_of_verification' },
      video: {
        formats: ['MP4', 'WebM'],
        minimumResolution: '720x1280',
        maxDurationMinutes: 30,
        maxFileSizeGB: 10,
        safeZones: { top: '15%', bottom: '20%', right: '15%' },
        source: 'official_help_plus_house_reference',
      },
    },
  },
};

function getPlatformSpec(platform) {
  return PLATFORM_SPECS[String(platform || '').toLowerCase()] || null;
}

function getSurfaceSpec(platform, surface) {
  const spec = getPlatformSpec(platform);
  return spec?.surfaces?.[surface] || null;
}

function characterCount(value) {
  return Array.from(String(value || '')).length;
}

function validateSurfaceText({ platform, surface, text }) {
  const value = String(text || '');
  const length = characterCount(value);
  const rule = getSurfaceSpec(platform, surface);
  if (!rule) return { status: 'UNKNOWN', reason: 'No surface contract is registered for this platform.' };
  if (Number.isFinite(rule.platformMaxChars) && length > rule.platformMaxChars) {
    return { status: 'BLOCK', reason: `Exceeds documented ${surface} limit of ${rule.platformMaxChars} characters.`, limit: rule.platformMaxChars, source: rule.platformMaxSource, characterCount: length };
  }
  if (Number.isFinite(rule.qualityMaxChars) && length > rule.qualityMaxChars) {
    return { status: 'BLOCK', reason: `Exceeds the studio ${surface} quality ceiling of ${rule.qualityMaxChars} characters.`, limit: rule.qualityMaxChars, source: rule.qualityMaxSource, characterCount: length };
  }
  return {
    status: 'PASS',
    reason: Number.isFinite(rule.platformMaxChars) ? `Within ${rule.platformMaxChars}-character platform limit.` : 'No documented platform maximum exceeded; within studio quality ceiling.',
    limit: Number.isFinite(rule.platformMaxChars) ? rule.platformMaxChars : rule.qualityMaxChars,
    source: Number.isFinite(rule.platformMaxChars) ? rule.platformMaxSource : rule.qualityMaxSource,
    characterCount: length,
  };
}

function capabilityFor({ platform, action = 'comment', targetScope = 'external' }) {
  const spec = getPlatformSpec(platform);
  const actionSpec = spec?.actions?.[action];
  if (!actionSpec) return { status: 'UNKNOWN', reason: 'No action contract is registered.' };
  const allowed = targetScope === 'owned' ? actionSpec.owned : actionSpec.external;
  return {
    status: allowed ? 'READY' : 'BLOCK',
    allowed,
    targetScope,
    route: actionSpec.route,
    reason: allowed ? 'Official route is documented for this target scope.' : (actionSpec.reason || `Official ${action} route is not documented for ${targetScope} targets.`),
  };
}

const PLATFORM_CAPABILITIES = Object.fromEntries(Object.entries(PLATFORM_SPECS).map(([id, spec]) => [id, {
    ...spec,
    specSnapshot: SNAPSHOT_DATE,
    comment: Boolean(spec.actions.comment.external || spec.actions.comment.owned),
    like: Boolean(spec.actions.like.external || spec.actions.like.owned),
    readBack: id === 'youtube',
  }]));

module.exports = {
  SNAPSHOT_DATE,
  PLATFORM_SPECS,
  PLATFORM_CAPABILITIES,
  capabilityFor,
  characterCount,
  getPlatformSpec,
  getSurfaceSpec,
  validateSurfaceText,
};

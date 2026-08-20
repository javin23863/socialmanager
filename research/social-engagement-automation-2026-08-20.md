# Provider-agnostic niche-aware social engagement studio

Research date: 2026-08-20

## Decision

Build a local-first desktop studio with a provider-agnostic decision core:

```text
official context -> normalized evidence -> niche/audience ranker
                 -> structured candidate generation -> deterministic gates
                 -> policy decision -> provider mutation -> exact read-back
                 -> outcome metrics -> evaluation set
```

Autonomous means that the configured policy runs this loop without a serial approval request for every comment. It does not mean that an available endpoint authorizes scraping, impersonation, spam, or artificial engagement. The application must fail closed when context, capability, policy, idempotency, or verification is missing.

## What the official interfaces establish

| Provider | Context established | Mutations established | Product ceiling |
| --- | --- | --- | --- |
| YouTube Data API | Recent niche-video discovery through `search.list`, video metadata/statistics, comment threads, replies, channel-associated comments, and authorized caption tracks. | Top-level comments, replies, moderation, and authorized-user video ratings. | The API endpoint is not a fake-engagement exemption. YouTube's spam and fake-engagement policies prohibit automatic systems that artificially increase likes, comments, views, or other metrics. The product must not turn `videos.rate` into an automatic like farm. |
| Instagram / Meta | Professional-account media, comments/replies on connected media, mentions, hashtagged media, and account metrics where permitted. | Manage/reply to comments on the connected professional account's media and publish/manage owned media. | The reviewed official collection does not establish a general API for mass-liking, following, or commenting on arbitrary third-party media. Treat external discovery and owned-account community care as different capability families. |
| TikTok Content Posting API | Creator information and the connected user's own publishing workflow. | Direct Post or Upload Content for an authorized user's account, with status fetch/webhooks. | This is a publishing interface, not a general external-engagement interface. |
| TikTok Research API | Public video fields including voice-to-text/subtitles and public comments for approved eligible researchers. | Query only. | TikTok's reviewed FAQ says commercial creators/advertisers are not eligible for Research Tools and warns that data may be delayed. It is not a live commercial engagement feed. |

The app must show this matrix per connected account and refuse actions outside a provider adapter's declared capabilities. “Not proven by the official docs” is a hard ceiling, not an invitation to use private APIs or DOM automation.

## Platform-specific publishing and copy contracts

This is a mechanics contract, not a claim that one export or one caption should be copied unchanged across networks. The standalone app stores each surface separately in `src/core/platform-specs.cjs`. Every numeric value has a source label; `undocumented` means the reviewed first-party material did not publish a number and the app must not manufacture one.

| Platform | Comment/action contract for this app | Documented or house-referenced text limits | Media/form constraints used by the app |
| --- | --- | --- | --- |
| YouTube | External and owned comments can use the official Data API with OAuth and exact read-back. Automated likes are blocked by product policy because the API route is not a fake-engagement exemption. | Title 100 and description 5,000 are official. The reviewed API docs expose a `commentTextTooLong` error but do not publish a numeric comment maximum; the app uses a labeled 600-character studio quality ceiling rather than pretending that 600 is YouTube's limit. | Shorts are square or vertical up to 3 minutes according to YouTube Help. Long-form title/description remain separate surfaces. |
| Instagram | The reviewed official route supports comments/replies on connected professional owned media. Proactive comments on arbitrary external media are blocked; private collection or DOM automation is not a fallback. | Bio 150 is official Help. Caption 2,200 is a house-reference value that must be re-verified for a critical publish. Comment maximum was not published in the reviewed official docs. | Reels Help documents 1.91:1–9:16, minimum 720px and 30fps. Organic duration is kept as a freshness-sensitive account/app rule rather than copied from an ad limit. |
| Facebook | Page-managed/owned comments are expressible; arbitrary external proactive comments and likes are blocked until a specific official route and scope are documented. | The reviewed official docs do not publish a general comment/caption maximum; the app uses a labeled studio ceiling only. | Facebook Help documents MP4/MOV, up to 240 minutes and 4GB for video uploads. A current Help page describes Reels up to 90 seconds while also documenting a transition to broader video-as-Reels handling, so this is rechecked per target surface. |
| TikTok | Content Posting is an own-account publishing route. The reviewed Research API is an approved, delayed read route; neither establishes general external comment mutation. | Comment maximum was not published in the reviewed official docs. Caption 4,000 and bio 80 remain house-reference values marked “verify,” never silently treated as provider facts. | TikTok Help documents MP4/WebM, 720x1280 or higher, up to 30 minutes and under 10GB for web upload. Safe-zone percentages come from the house publishing reference and stay labeled accordingly. |

Primary mechanics sources: [YouTube Shorts](https://support.google.com/youtube/answer/15424877), [YouTube video settings](https://support.google.com/youtube/answer/57404), [YouTube comment API](https://developers.google.com/youtube/v3/docs/comments/update), [Instagram Reel dimensions](https://www.facebook.com/help/1038071743007909), [Instagram bio](https://www.facebook.com/help/instagram/728994388226960), [Facebook video limits](https://www.facebook.com/help/121317464722113), [Facebook Reels](https://www.facebook.com/help/www/2862139500770200), and [TikTok Studio upload requirements](https://support.tiktok.com/en/using-tiktok/creating-videos/creator-tools-on-tiktok). The local `platform-publishing-specs` skill remains the house reference, with a freshness check for critical limits.

## Architecture to preserve

```text
Desktop UI
  |-- workspace/profile editor
  |-- autonomy matrix and budgets
  |-- context viewer with provenance
  |-- candidate/gate inspector
  |-- run timeline and receipts
  |-- analytics and experiments
        |
Local orchestration core
  |-- durable run state
  |-- context normalization
  |-- niche/audience ranker
  |-- LLM adapter router
  |-- deterministic anti-slop gates
  |-- policy engine
  |-- idempotent outbox
  |-- read-back verifier
  |-- metrics/evaluation loop
        |
Provider adapters              LLM adapters
  |-- YouTube Data API           |-- OpenAI-compatible
  |-- Meta Graph/Instagram       |-- Anthropic
  |-- TikTok APIs                |-- Gemini
  |-- future official routes     |-- local/custom HTTP
```

The renderer never calls a provider mutation directly. The local core owns state transitions and credentials. This prevents duplicate writes when the UI reconnects or a run continues after the window closes.

## Context bundle

Every candidate is bound to a versioned, bounded evidence object:

```json
{
  "target": {"provider": "youtube", "account_id": "...", "object_id": "...", "url": "..."},
  "media": {"title": "...", "description": "...", "caption": "...", "published_at": "..."},
  "transcript": {"text": "...", "source": "official_caption|user_file|none", "language": "..."},
  "conversation": [{"id": "...", "parent_id": "...", "text": "...", "created_at": "..."}],
  "metrics": {"likes": null, "comments": null, "views": null, "observed_at": "..."},
  "retrieval": {"fetched_at": "...", "content_hash": "...", "source_ids": ["..."]}
}
```

Every excerpt used by a generated sentence needs a stable source locator: provider object ID, comment ID, caption track ID, time range, or local file hash. If the system cannot identify the anchor inside the bundle, the candidate cannot pass the context gate. External content is data, never an instruction; prompt-injection text in a caption or comment must not change policy or tool permissions.

## Candidate contract

The LLM adapter returns structured candidates, not executable actions:

```json
{
  "candidates": [
    {
      "id": "candidate-1",
      "mode": "observation + test",
      "text": "...",
      "evidence": ["exact source phrase", "exact source phrase"],
      "valueAdd": "test|question|contrast|clarification",
      "risk": "low|medium|high"
    }
  ]
}
```

The core applies its own schema and semantic validation even when a provider advertises structured output. Provider fallbacks preserve the same schema and gate thresholds; a model that cannot produce the required contract abstains.

## Gate order

1. Schema and length validation.
2. Context sufficiency and freshness.
3. Evidence-anchor existence and source locator validation.
4. Niche and audience fit.
5. Value-add classification: observation, test, question, contrast, or clarification.
6. Unsupported-claim and financial-risk checks.
7. Promotion, link, hashtag, impersonation, and CTA checks.
8. Generic-opening, AI-tell, repetition, and near-duplicate checks.
9. Account/platform capability and scope checks.
10. Rate budget, cooldown, saturation, and idempotency checks.
11. Independent critic or deterministic regression set.
12. Provider mutation, then exact read-back verification.

Gates emit a specific verdict (`PASS`, `BLOCK`, `HOLD`, `RETRYABLE`, or `UNKNOWN`) and machine-readable reasons. Silence is not approval. A provider response that accepted a mutation but cannot be read back is `UNKNOWN`, not success; retry only after reconciliation.

The current deterministic critic is intentionally labeled `deterministic_critic_v1`. It blocks the literal regression fixtures for generic praise, promotion, missing evidence, and common AI-tell phrases. Its receipt also states that human readability and an independent model opinion are not performed; those are future coverage, not silent passes.

## Autonomous policy

The operator sets policy once in the desktop UI. Routine actions can run without per-action approval only when all gates pass. The app still exposes:

- account/provider action-class switches;
- rolling and daily budgets;
- cooldowns and diversity limits;
- content-risk thresholds and mandatory abstention;
- a global kill switch and provider circuit breakers;
- dry-run/replay mode;
- a live outbox/receipt ledger;
- an exception inbox for genuine failures, not routine copy approval.

## Durable state and feedback

The first desktop slice uses local JSON plus JSONL to keep the runtime dependency-light. The durable target schema is relational once the run volume warrants it:

```text
workspace -> provider_account -> source_item -> context_bundle
                                     |
candidate -> gate_result -> mutation -> receipt -> metric_snapshot
                                     |
                              evaluation_example
```

Mutation states are `queued -> dispatched -> provider-accepted -> read-back-verified -> measured`, with `skipped`, `held`, `retryable`, `failed`, and `unknown` exits. Metrics should measure meaningful conversation: reply depth, creator response, profile visits, follows attributable to the interaction, and downstream retention—not raw likes alone. Verified outcomes become evaluation examples for ranking and gate regression.

## Implementation patterns worth borrowing

- Postiz: provider adapters, official-auth boundaries, and analytics surfaces.
- Chatwoot: event/condition/action automation with an exception path.
- n8n queue mode: durable job separation and worker/backpressure patterns.
- Langfuse/Phoenix: trace IDs, evaluations, datasets, and feedback loops around model calls.
- Electron's own security guidance: context isolation, sandboxing, restrictive CSP, sender validation, limited navigation, and current Electron releases. Secrets use Electron `safeStorage`, not ordinary state files.

## First implementation sequence

1. Contracts before connectors: context bundle, candidate schema, gate verdicts, capability matrix, receipt schema.
2. Local studio and no-mutation loop: ingest, generate, gate, inspect, simulate, ledger.
3. Owned-account autonomous care: add official provider actions where scopes and read-back are proven.
4. Multi-provider capability map: keep unsupported external engagement visibly unsupported.
5. Outcome learning: add verified metric snapshots and evaluation examples.
6. New provider actions only after the official route, scope, rate limits, and read-back contract are documented and tested.

## Primary sources

- YouTube comments: <https://developers.google.com/youtube/v3/guides/implementation/comments>
- YouTube recent-video discovery: <https://developers.google.com/youtube/v3/docs/search/list>
- YouTube comment insertion: <https://developers.google.com/youtube/v3/docs/commentThreads/insert>
- YouTube captions: <https://developers.google.com/youtube/v3/guides/implementation/captions>
- YouTube videos and ratings: <https://developers.google.com/youtube/v3/docs/videos>
- YouTube quota: <https://developers.google.com/youtube/v3/determine_quota_cost>
- YouTube spam policy: <https://support.google.com/youtube/answer/2801973>
- YouTube fake engagement policy: <https://support.google.com/youtube/answer/3399767>
- Meta Instagram API collection: <https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api>
- Meta Graph API rate limiting: <https://developers.facebook.com/docs/graph-api/overview/rate-limiting/>
- Meta Automated Data Collection Terms: <https://www.facebook.com/legal/automated_data_collection_terms>
- Meta Terms: <https://www.facebook.com/legal/terms>
- TikTok Research API overview: <https://developers.tiktok.com/doc/about-research-api>
- TikTok Research API videos: <https://developers.tiktok.com/doc/research-api-specs-query-videos/>
- TikTok Research API comments: <https://developers.tiktok.com/doc/research-api-specs-query-video-comments>
- TikTok Research API FAQ: <https://developers.tiktok.com/doc/research-api-faq>
- TikTok Content Posting Direct Post: <https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>
- Electron security: <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron context isolation: <https://www.electronjs.org/docs/latest/tutorial/context-isolation>
- Electron safe storage: <https://www.electronjs.org/docs/latest/api/safe-storage>
- Electron process model: <https://www.electronjs.org/docs/latest/tutorial/process-model>

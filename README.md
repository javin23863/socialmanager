# Social Engagement Studio

Standalone Windows desktop application for niche-aware, context-first social engagement. It is separate from TraderCockpit and owns its own persisted automation worker; it does not use TraderCockpit's daily scheduler or a calendar schedule.

## Current vertical slice

- Electron desktop shell with context isolation, sandboxing, restrictive local CSP, and a narrow preload bridge.
- Editable market/trading niche profile and audience needs.
- Local demo LLM plus a keyless-local or authenticated OpenAI-compatible provider adapter.
- Separate YouTube, Instagram, Facebook, and TikTok surface contracts for comments, captions, bios, titles, descriptions, and media constraints.
- Source-labeled character limits: documented platform maximums are distinct from studio quality ceilings and undocumented values stay unknown.
- YouTube URL hydration through the official Data API for metadata and public comments.
- Context pack with provenance fields, topic hits, source anchors, and a context fingerprint.
- Structured candidate contract and deterministic anti-slop gate engine.
- Separately configurable generation and independent critic model calls with strict per-candidate PASS/BLOCK/NOT_PERFORMED verdicts; malformed or timed-out criticism fails closed for live execution.
- Official YouTube niche discovery across recent videos, followed by a bounded multi-target run with no per-comment approval loop.
- YouTube desktop OAuth through the system browser with loopback PKCE, the single `youtube.force-ssl` comment scope, offline refresh, rotation-aware storage, and recoverable reconnect/disconnect status.
- Per-run and rolling-24-hour budgets, target/account cooldowns, minimum gate score, and a global kill switch.
- Simulation receipts plus a durable dispatched/verified/failed/unknown mutation ledger; simulation never blocks later live promotion.
- YouTube live-comment adapter with action-bound gate recomputation, official-context provenance, exact provider read-back, and automatic retry lockout when the outcome is unknown.
- Official Meta owned-media adapters for connected professional Instagram actors and Facebook Pages, with fresh provider ownership checks, parent-edge reply read-back, actor identity binding, Graph API version and permission receipts, and no external proactive Meta writes. The Instagram lane is reply-only; Facebook Page care supports the managed Page comment/reply surface.
- A bounded owned-media cycle for Instagram and Facebook that processes eligible inbound comments without a per-comment approval loop; the existing YouTube cycle remains the external niche-discovery lane.
- A persisted backend automation worker that runs enabled YouTube, Instagram, and Facebook cycles sequentially on a configurable interval, resumes after application restart, records the next run and last outcome, and never overlaps cycles. Missing provider setup remains visible as a blocked readiness result while the worker continues its bounded schedule.
- Authorized media inspection for explicitly supplied local video plus VTT/SRT/TXT transcript files, deterministic frame hashes, optional configured-provider transcription, timestamped provenance, and an optional configured vision model. Missing semantic audio or visual analysis is visible and cannot be implied by the model.
- SQLite-backed actor registry, encrypted credential references, migration backups, corruption recovery status, append-only mutation transitions, provider-backed reconciliation, immutable operator-pinned exemplars, provider-sourced metric snapshots, evidence-bearing immutable evaluation examples, and campaign-level semantic diversity gates.
- Visible platform capability matrix: unsupported proactive routes stay blocked instead of silently switching to browser automation.

## Run locally

```powershell
npm install
npm test
npm run check
npm start
```

On Windows, `run-studio.cmd` launches the same desktop window outside Codex after dependencies are installed. The packaged installer is the normal operator path once the signing certificate is configured; Node.js, npm, and Codex are not runtime requirements for the packaged build.

Release packaging is intentionally fail-closed around code signing and build provenance. `npm run package:dir` creates a local unpacked smoke-build and is unsigned; `npm run package:installer` refuses to run unless `CSC_LINK` or `WIN_CSC_LINK` points to the Windows signing certificate (with `CSC_KEY_PASSWORD` set when required by the certificate) and the checkout is clean and committed. Live writes also refuse a dirty or unversioned build. The NSIS policy uses a per-user install and retains the app-data directory on uninstall so SQLite receipts and OS-protected credentials are not silently destroyed. A future uninstall/data-reset flow must be an explicit operator choice.

Local authorized-video inspection uses `ffprobe` and `ffmpeg` for deterministic metadata, frame extraction, and optional 16 kHz audio extraction. Keep those tools available on the Windows `PATH` (or provide the packaged equivalents in a future installer wave); if they are unavailable, the app fails closed and cannot claim semantic visual inspection or provider transcription. VTT, SRT, or TXT transcripts remain explicitly file-hash-bound inputs. When no transcript file is supplied, configure a transcription model on the OpenAI-compatible adapter to enable the multipart `/audio/transcriptions` route; any provider failure is recorded as unavailable rather than becoming invented context.

The local demo provider is preview-only and does not represent a connected production account. A new install opens with no synthetic source context. The standalone build is preconfigured with the existing public TraderCockpit YouTube desktop OAuth client; enter that client’s secret once, save the connection settings, and choose `CONNECT YOUTUBE` to complete Google's authorization in the signed-in browser. A separate YouTube Data API key is optional: the connected OAuth grant supplies discovery and context as well as comments. For Meta, the existing Trader Cockpit App ID is prefilled; enter its App Secret once, save it, and choose `CONNECT META` to authorize the managed Page and linked professional Instagram account. Do not paste an access token. Refresh, access, and Meta actor tokens are stored through Electron `safeStorage` and are never exposed to the renderer, model prompts, repository files, logs, or ordinary receipts. After one-time setup, enable the autonomous worker once; it runs the configured surfaces without asking for each comment.

## Operating model

After the operator configures a policy, the backend worker discovers or reads each enabled surface, hydrates official context, generates and independently critiques each candidate, and processes up to the configured per-run limit without asking for approval on each comment. YouTube is the external niche-discovery lane; Instagram and Facebook cycles are owned-media community care and only reply to comments returned for the connected actor. Public execution is still bounded by provenance, copy quality, deterministic anti-slop findings, critic PASS, platform capability, rolling budget, cooldowns, idempotency, fresh ownership proof, and exact provider read-back. A passing copy gate cannot authorize an unsupported platform action. The top-bar `RUN AUTOMATION NOW` action is a bounded diagnostic trigger for the same worker; it is not required for normal operation. TikTok is intentionally last and remains visible, tailored, and fail-closed until its permitted official scope is implemented.

## Explicit boundaries

- No private API calls, DOM scraping, browser-click automation, or detection evasion.
- No automatic like/follow farm. A provider's rating endpoint is not treated as permission to manufacture engagement.
- No pasted short-lived YouTube access-token workflow; reconnect is required when offline authorization is missing or revoked.
- No calendar scheduler or dependency on TraderCockpit's scheduler; automation uses the app's persisted interval worker.
- TikTok external commenting, replying, and likes remain blocked; Content Posting/Research APIs are not reinterpreted as permission to mutate arbitrary third-party videos.
- No credentials, tokens, room links, or private URLs in source control.

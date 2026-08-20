# Social Engagement Studio

Standalone Windows desktop application for niche-aware, context-first social engagement. It is separate from TraderCockpit and has no calendar scheduler.

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
- Per-run and rolling-24-hour budgets, target/account cooldowns, minimum gate score, and a global kill switch.
- Simulation receipts plus a durable dispatched/verified/failed/unknown mutation ledger; simulation never blocks later live promotion.
- YouTube live-comment adapter with action-bound gate recomputation, official-context provenance, exact provider read-back, and automatic retry lockout when the outcome is unknown.
- Visible platform capability matrix: unsupported proactive routes stay blocked instead of silently switching to browser automation.

## Run locally

```powershell
npm install
npm test
npm run check
npm start
```

On Windows, `run-studio.cmd` launches the same desktop window outside Codex after dependencies are installed.

The default demo provider uses a synthetic fixture so the first run does not need credentials. Configure credentials in the app only when you are ready; secrets are stored through Electron `safeStorage` and are never written to repository files or ordinary receipts.

## Operating model

After the operator configures a policy, one YouTube niche cycle discovers recent targets, hydrates official context, generates and independently critiques each candidate, and processes up to the configured per-run limit without asking for approval on each comment. Public execution is still bounded by provenance, copy quality, deterministic anti-slop findings, critic PASS, platform capability, rolling budget, cooldowns, idempotency, and exact provider read-back. A passing copy gate cannot authorize an unsupported platform action. YouTube is the first live adapter because its official comment route and read-back contract are explicit; Meta and TikTok remain visible, tailored, and fail-closed until their exact official action scope is proven for the selected target.

## Explicit boundaries

- No private API calls, DOM scraping, browser-click automation, or detection evasion.
- No automatic like/follow farm. A provider's rating endpoint is not treated as permission to manufacture engagement.
- No calendar scheduler in this repository's first slice.
- No credentials, tokens, room links, or private URLs in source control.

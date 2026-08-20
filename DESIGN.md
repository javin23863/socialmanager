# Social Engagement Studio — Context Atlas

This record is derived from the shipped Electron renderer on 2026-08-20. Product truth remains in `PRODUCT.md`; platform mechanics and source freshness remain in `research/social-engagement-automation-2026-08-20.md` and `src/core/platform-specs.cjs`.

## World

- Scene: a creator/operator reviews a bounded engagement run at a Windows desk, with the source evidence, candidate copy, and action truth visible at the same time.
- Material: cool graphite workspace, paper-white evidence sheets, a cooler paper-deep control layer, cobalt route marks, oxidized green passes, amber warnings, and red blocks.
- Typography: one system sans stack for legibility and native desktop familiarity; compact tracked labels are reserved for state and section metadata.
- Depth: 1px rules establish the atlas and one soft offset shadow separates paper panels from the graphite field. No gradients, glass, or decorative glow.

## Composition

- The top bar names the studio, exposes the bounded-run state, keeps the kill switch visible, and makes `RUN YOUTUBE NICHE CYCLE` the primary action.
- The first working surface is a three-part context atlas: a narrow policy/profile rail, a two-column source/candidate workbench, and a right inspection rail for gates, capabilities, receipts, and fail-closed notes.
- Evidence anchors are rendered as source chips; the candidate route carries its evidence chips into the selected state; gate rows show a marker, reason, and explicit PASS/BLOCK result.
- The gate field keeps deterministic anti-slop and independent model-critic verdicts separate; an unperformed critic is visibly held rather than rendered as a green live-ready state.
- Capability rows expose the platform route, scope, surface limits, source snapshot, and the difference between documented platform values and studio quality ceilings.
- The YouTube connection panel exposes the requested comment scope and non-secret connection status; authorization happens in the system browser and returns through a PKCE-protected loopback callback.

## Interaction and state language

- `PASS` is green only when deterministic gates and the declared provider/scope contract pass.
- `BLOCK` is red and names the machine-readable reason; unsupported Meta/TikTok external routes never degrade into browser automation.
- `UNKNOWN` is reserved for provider outcomes that cannot be read back exactly; it is never rendered as success.
- Simulation is always available for a passing candidate. Live execution requires the configured autonomy policy, the live-write arm, an official adapter, idempotency, and exact provider read-back.
- Live execution additionally requires the separately configured critic model to return `PASS` for every candidate; `NOT_PERFORMED` is simulation-only.
- Pause is a global kill switch. Reduced-motion media rules keep state transitions legible without animation.
- `AUTHORIZING`, `CONNECTED`, `CONFIGURED`, `ERROR`, and `DISCONNECTED` are explicit connection states; no access or refresh token is rendered.

## Responsive and accessibility rules

- The desktop target keeps the atlas visible at 1500×980 and collapses the inspection rail below the workbench at narrower widths; the source/candidate pair stacks below the atlas breakpoint.
- Inputs use native controls, explicit labels, visible focus rings, semantic landmarks, live status regions, and disabled states. Color is paired with text (`PASS`, `BLOCK`, `PAUSED`, `UNKNOWN`).
- The UI uses no external font or image dependency, keeps content visible before motion, and honors `prefers-reduced-motion`.

## Finish evidence

- Impeccable detector on this project: `node C:\Users\MSI\Documents\tradercockpit\.agents\skills\impeccable\scripts\detect.mjs --json` → `[]`.
- Desktop evidence: live Electron window inspected through the Windows Computer Use surface; the accessibility tree exposed platform selection, target scope, source bundle, tailored surface summaries for all four networks, candidate gates, critic coverage, and receipt ledger.
- Fresh external finish reviewer: attempted with a clean agent as required by the playbook, but it timed out and was shut down; this is an explicit degraded in-thread review, not an implied reviewer pass.

## Direction contract

THESIS: Make the evidence-to-comment route visible so autonomous execution feels accountable rather than magical.

OWN-WORLD: A cool graphite field with paper-white evidence sheets, cobalt route marks, oxidized-green passes, and amber holds.

STORY: The operator sees the source, the candidate, the exact gate verdict, the platform capability, and the receipt in one bounded run.

FIRST VIEWPORT: A narrow policy rail frames a source field on the left, a candidate route in the center, and the gate/capability inspection rail on the right; `RUN CYCLE` is the primary action in the top bar.

FORM: Context atlas, third of the grounded direction set; the selected direction seed was `74d35897` and the surface seed was `33e18a07`.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md

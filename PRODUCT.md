# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Electron desktop shell with a framework-light web renderer and a Node runtime; keep the provider and gate modules independently testable and avoid a UI framework until the first vertical slice proves it is needed.

## Users

The primary user is a creator or operator running their own social accounts. They configure a niche, target audience, voice, account boundaries, model provider, and autonomous execution policy, then inspect and control the engagement system from a Windows desktop application. The first intended profile is a market/trading education audience, but the profile itself must be editable rather than hard-coded.

## Product Purpose

Social Engagement Studio finds relevant public conversations, assembles evidence about the target video and its active discussion, generates comments that add specific value, and executes only work that survives the configured quality and provider gates. Success means increasing useful, on-topic conversations and learning which context, voice, and target choices produce meaningful downstream engagement without flooding platforms with repetitive or deceptive activity.

## Positioning

The product treats every public action as an evidence-backed decision: context, audience fit, generated copy, deterministic anti-slop findings, provider capability, rate budget, idempotency key, and provider read-back travel together. The model is replaceable; the gate and receipt contract are not.

## Operating Context

The app runs outside Codex as a local desktop workspace. The operator can set or change an LLM provider, use a local or remote OpenAI-compatible endpoint, inspect the model conversation, run a bounded autonomous cycle, pause execution, and review durable run receipts. The initial product slice has no calendar scheduler; autonomy is an explicit run mode that can be started and stopped from the app.

## Capabilities and Constraints

- Maintain editable niche, audience, voice, safety, and rate-limit profiles.
- Ingest target URLs or pasted/source material and retain context anchors, timestamps, comments, captions when an authorized provider route exposes them, and source provenance.
- Generate multiple candidate comments through a provider adapter, then choose or reject them through deterministic gates plus configurable model critique.
- Require a separate, read-only critic call for live work; every candidate records `PASS`, `BLOCK`, or `NOT_PERFORMED`, and missing, malformed, ambiguous, or timed-out criticism cannot reach the public action seam.
- Reject generic, repetitive, self-promotional, unsupported, unsafe, or context-poor copy before any public write.
- Route actions only through provider capabilities that are explicitly declared and authorized; unsupported or policy-sensitive routes fail closed and remain visible.
- Execute with per-platform and per-account budgets, cooldowns, deduplication, idempotency, retry classification, and provider read-back receipts.
- Connect YouTube through a system-browser desktop OAuth flow using PKCE and the smallest comment scope; refresh, rotation, revocation, and reconnect state remain inside the main process and OS-protected storage.
- Keep credentials in the local OS credential store or an explicitly configured local secret mechanism; never write secrets into the repository, run receipts, or model transcript.
- Treat viral reach as an optimization target, never as a guaranteed claim. Measure conversation quality and downstream results instead of maximizing raw action count.

## Brand Commitments

The interface should feel like an operator's instrument: direct, legible, evidence-first, and calm under failure. It must not present a green light when a provider route, context source, or gate is unavailable.

## Evidence on Hand

The operator supplied the product blueprint: niche-targeted discovery, video-context understanding, value-adding comments, autonomous execution, and existing anti-slop skills as the quality authority. Current platform capability research is recorded separately in the repository's research notes. No account credentials, provider keys, private URLs, or durable access tokens are part of the product record.

## Product Principles

1. Context before copy.
2. Gates before public actions.
3. Provider capability is a fact, not an assumption.
4. Autonomy is bounded by budgets, idempotency, receipts, and a kill switch.
5. The model can change; the evidence contract must remain stable.

## Accessibility & Inclusion

The desktop UI must support keyboard navigation, visible focus, readable contrast, reduced-motion preferences, semantic labels, and clear non-color status communication. Error and blocked states must explain recovery rather than merely showing a red indicator.

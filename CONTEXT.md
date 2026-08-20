# Social Engagement Studio domain glossary

This glossary names the concepts that cross the application and provider
surfaces. It deliberately avoids implementation details.

## Actor account

The connected platform identity on whose behalf an action is performed. An
actor account belongs to exactly one platform and has its own capabilities,
policy, status, and budget.

## Target account

The platform identity that owns or publishes the media being inspected. A
target account is not interchangeable with the actor account; an action may
address an external target on a platform that permits it, or a managed target
when the platform contract limits care to owned media.

## Target media

The specific video, reel, post, or other provider object that supplies the
context for an action. It has a stable provider identifier and a provider URL
when one exists.

## Action

The bounded provider operation proposed by the studio, such as a comment or a
reply. An action has a platform, actor account, target media, target scope,
approved text, and a single mutation identity.

## Context bundle

The source material available to the writer and critic for one target media
item. It includes provenance for every usable evidence anchor and states when
transcript or visual evidence is unavailable.

## Gate

The deterministic and model-critic evaluation that decides whether a proposed
action is eligible for simulation or live execution. A gate is explicit: PASS,
BLOCK, or NOT_PERFORMED where the contract permits the latter.

## Receipt

The durable record of an action transition, including its identity, actor,
target, context fingerprint, gate verdicts, provider evidence, and final
status. A successful request without exact provider read-back is not a live
receipt.

## Mutation state

The state of a provider write: DISPATCHED, PROVIDER_ACCEPTED, LIVE_VERIFIED,
FAILED, or UNKNOWN. UNKNOWN means the provider may have applied the mutation
and must be reconciled before another attempt.

## Reconciliation

The provider-backed process that resolves an UNKNOWN mutation by proving that
the original action exists or does not exist. Reconciliation records its
resolver and evidence and never silently deletes the uncertainty.

## Capability

The provider and account permission that authorizes a particular action on a
particular target scope. Capabilities belong to the actor account; they are
never inherited from another account.

## Policy

The bounded rules for an actor account and platform, including budgets,
cooldowns, allowed target scopes, and circuit-breaker behavior.

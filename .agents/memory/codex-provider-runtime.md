---
name: Codex via ChatGPT Plus provider
description: Durability, serialization, billing-honesty, and packaging constraints for the Codex provider that the code alone does not explain.
---

# Codex provider

## Serialize with a lease row, never a second advisory lock

One ChatGPT credential may only ever run one Codex job at a time. That is
enforced with a durable lease row keyed by a hash of the auth *file path*.

**Why:** the worker singleton takes Postgres advisory lock `0x484f4d41` and
holds it for the process's whole life. Any second advisory lock taken on that
same connection risks hanging the worker outright — this was the concrete
reason the lease-table design was chosen over the obvious "just add another
lock key". A table row also survives a restart and works across processes,
which an advisory lock tied to one connection does not.

**How to apply:** any future per-credential or per-resource serialization in
this server should follow the same pattern rather than reaching for another
advisory-lock key. A TTL lease is only half the design — the holder must also
heartbeat while work is in flight and abort the moment a renewal is refused.
Without that, any call that outlives the TTL silently permits exactly the
concurrency the lease was added to prevent, and an attempt that has lost its
lease must requeue rather than report an outcome it can no longer vouch for.

## Never report a cost for a subscription provider

Subscription-backed runs record `null` cost, not `0`, and no remaining
allowance is displayed anywhere.

**Why:** neither Claude Code nor Codex publishes a per-token price, and no
plan exposes a balance. A `$0.00` line reads as "this was free and measured"
when in fact nothing was measured — it is a fabricated number in the owner's
spend record.

**How to apply:** classify providers as `subscription` vs `metered` and key
budget ceilings, pricing lookups, and paid-fallback consent off that
classification. When adding a provider, decide its billing class first.

## Fallbacks require an explicit decision

A provider that runs out of allowance or fails to authenticate leaves the task
stopped. Rerouting happens only on an owner action or a pre-configured
consent-and-limit policy, and the policy is re-evaluated at execution time
rather than trusted from when consent was given.

**Why:** silently moving work from a plan-covered provider to a metered one
spends real money the owner never agreed to.

## The SDK is a wrapper around a native binary

`@openai/codex-sdk` does nothing on its own; it spawns the platform-specific
CLI from `@openai/codex`. Both must stay bundler-external.

**Why:** bundling produces a module that imports fine and then fails with an
opaque spawn error mid-run. Resolution also has to start from the SDK's
*realpath* — pnpm links through a store, so resolving from the symlink misses
the CLI installed beside it.

## "Durable storage" cannot be detected, only attested

A writable, correctly-permissioned, absolute directory tells you nothing
about whether it survives a redeploy — a persistent volume and an autoscale
instance's scratch disk are indistinguishable from inside the container.

**Why:** the Codex CLI rewrites its credential file on every token refresh,
so storing it on scratch does not degrade slowly; the login silently dies at
the next deploy and resurfaces later as a confusing auth error.

**How to apply:** for any credential whose file the provider itself rewrites,
require an explicit operator attestation rather than inferring durability
from a successful write probe, and separately hard-refuse the roots that are
provably ephemeral. Apply the gate on *every* path that touches storage —
the setup/bootstrap writer as much as the execution path, or the credential
gets written to a location execution will then refuse to read.

## A path gate must compare canonical paths

Any check that classifies a filesystem location has to resolve `..` *and*
symlinked components first.

**Why:** a raw string comparison is defeated by `/looks-durable/../tmp/x` and
by a symlink whose target is elsewhere, while every syscall afterwards uses
the resolved target. The check then reports safety it did not verify.

**How to apply:** resolve the deepest existing ancestor and re-attach the
remainder, since the directory being validated usually does not exist yet.

## A lease check belongs before the write, not only in the catch

**Why:** a heartbeat fires on a timer, so it cannot cover the window between
the provider call resolving and the outcome being persisted. Handling lease
loss only in the error path lets a successful return be recorded for a
credential another run has already taken over — and a test that aborts the
call to simulate loss passes vacuously, because the abort routes it through
the catch block that already worked.

**How to apply:** confirm ownership explicitly once after the call returns
and before the first write, treating "cannot confirm" as lost. Verify any
guard of this kind by deleting it and watching the test fail.

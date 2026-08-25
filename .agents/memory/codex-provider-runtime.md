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

## The database owns the sign-in; the filesystem is a working copy

A CLI credential that the provider itself rewrites cannot live on the
container's disk on a published app. Store it encrypted in Postgres, write
it into a private per-account directory just before a run, and fold whatever
the CLI refreshed back into the row inside the same lease window.

**Why:** every deployment type wipes the filesystem, and "is this directory
durable?" is undetectable from inside a container — a persistent volume and
an instance's scratch disk look identical. An earlier design demanded an
operator attestation plus canonical-path gates against ephemeral roots; that
whole gate disappeared once the disk stopped being the source of truth, and
with it the requirement for a Reserved VM. Encrypt with a key derived from
an existing deliberately-rotated secret so rotation surfaces as "reconnect",
never as silent wrong behaviour.

**How to apply:** the write-back must be revision-guarded — stamp a new
revision on every connect and only save the refresh if the stored revision
still matches what the run materialized, or a run finishing will restore a
session the person just replaced or resurrect one they disconnected. Delete
the plaintext copy when the run ends. Status checks read metadata columns
only, but must still attempt one decrypt, or "ready" lies after a key
rotation.

## A credential file that parses is not a credential

Classify a ChatGPT `auth.json` as usable only when it carries actual token
material, not because it declares `auth_mode: "chatgpt"`.

**Why:** the CLI rewrites the file in place on every refresh, so a partial
write can be syntactically valid JSON with the mode field intact and no
tokens. Accepting it lets that fragment overwrite a working session on
write-back and lets status report a sign-in that authenticates nobody.

## Thread resume depends on scratch session files — retire, don't blindly replay

A stored Codex thread id is only resumable while its session/rollout files
survive under the scratch CODEX_HOME; every deploy restart wipes them while
the conversation row lives on, so resumes fail instantly and forever.

**Why:** Talk resumed the latest thread unconditionally and surfaced the
failure as a generic provider error on every send, while fresh tasks worked.

**How to apply:** on a resume-shaped failure, mark the conversation
unresumable so the next attempt starts fresh. Automatically replaying the
turn requires positive protocol proof the model turn never started (a
terminal provider event before turn.started → turnStarted=false); a rejected
SDK promise proves nothing and must fail closed — a subscription turn that
may have run must never be replayed, or the allowance is double-spent.
Recording a fresh SDK-issued thread id heals the row (resumable=true).

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

## Identity travels with the lease
The account a Codex run bills is snapshotted when the work is created (queue
time for tasks, turn start for Talk) and reused verbatim for the lease key,
the runtime, and every retry/recovery; nothing re-resolves it later.
**Why:** workspace ownership can change (legacy hand-over), and a second
lookup could run one account's session under another account's lease or bill
an account that never queued the work. Rows without a snapshot fail closed.
**How to apply:** any new Codex entry point must capture the owner once at
creation and carry it through; never derive it again from the workspace row
at execution time.

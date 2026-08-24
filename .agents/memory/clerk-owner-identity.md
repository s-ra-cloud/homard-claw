---
name: Clerk owner identity across environments
description: Why the single-owner gate keys off OWNER_EMAIL rather than a stored Clerk user id, and the rules any change to it must keep.
---

# Owner identity survives the development → production move

The office has one owner, recorded in `system_state.owner_clerk_id`. Clerk runs
**separate user stores for development and production**, so a Clerk user id is
only meaningful inside the instance that minted it. When production data is
seeded from development, the stored owner id names an account that cannot exist
in the live instance, and every real sign-in is refused with "This office
already has an owner" — a permanent lockout with no way back in from the app.

**Rule:** the durable owner identity is the `OWNER_EMAIL` environment variable.
The stored Clerk id is a cache. When a signed-in account's *verified* primary
email matches `OWNER_EMAIL`, ownership follows to that account's id. With
`OWNER_EMAIL` unset, the original first-authenticated-user claim still applies.

**Why:** an email is the one identifier the same human keeps across Clerk
instances, account recreations, and republishes. Anything id-shaped strands the
owner the first time the environment changes underneath them.

**How to apply** — anything touching the owner gate must keep all of these:

- Require `verification.status === "verified"`. An unverified address is a
  free signup away from being anyone's.
- Never cache a *match*. A stale positive keeps authorising an address the
  owner has since changed or lost. Cache only refusals, briefly, so a stranger
  hammering the API cannot amplify into a Clerk call per request.
- Fail closed. A Clerk outage, deleted user, or missing secret resolves to no
  email, which must mean "not the owner" — never "allow".
- Move ownership with a compare-and-set against the row the request read, and
  re-read before allowing, so two hand-overs cannot interleave.
- Changing the gate only fixes the deployed app after a republish; the
  production database cannot be repointed by hand from the workspace.

**Design smell to remember:** first-authenticated-user-claims-it is fine for a
private workspace and wrong for anything published — a stranger who signs up
before the owner takes the office, data and all. `OWNER_EMAIL` also closes that.

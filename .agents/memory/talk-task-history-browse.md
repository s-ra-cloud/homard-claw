---
name: Talk task-history browse
description: How Talk retrieves complete task histories — browse vs search modes, bounded page collection, owner-calendar dates.
---

# Talk task-history browse

Talk conversations use a bounded-exhaustive collector over stored task results, separate from the worker action-loop's single-page search (which is unchanged and model-paginated).

**The rules:**
- Two modes: full-text **search** (distinctive query words) vs chronological **browse** (no query, date/agent filters only). Queries made entirely of filler words ("all tasks today") are stripped server-side and treated as browse; filler "today"/"yesterday" set implicit day bounds.
- The collector walks up to 4 pages (20 records) and reports `{total, shown, complete}`; the compose round is told explicitly whether the set is complete or how many more exist, and must never present a partial page as the full history.
- Date-only bounds resolve to the *owner's* local midnight via TZDate using an optional `ownerTimezone` sent by the web client (both text and voice). Missing/invalid timezone → UTC; a date-only `until` becomes next-day local midnight (not +24h) to avoid DST drift. The worker path keeps historical UTC behavior.
- Browse mode appends a count (never content) of same-window records that are unfinished, output-less, or from a sandboxed agent, so agents distinguish "not browsable" from "doesn't exist".

**Why:** the deployed bug was Talk doing one model-chosen search of one 5-record page, so "summarize every task today" silently reported an incomplete or empty history.

**How to apply:** any new Talk-adjacent retrieval should reuse the collector (not the single-page executor), keep the browse/search distinction, and thread the owner timezone through. Tests that browse in the shared dev workspace must filter by agent name or use an otherwise-empty date window. One zero-match test depends on the exact phrase "No completed task results matched."

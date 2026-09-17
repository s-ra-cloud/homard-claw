---
name: Local PDF isolation
description: Why PDFs use canonical text and the non-obvious constraints on isolated Node parsing.
---

Keep extracted PDF text as the durable input across provider switches, task retries, and Talk proposal confirmation. Keep visible Talk utterances separate from bounded provider context, and explicitly mark context omissions.

**Why:** provider-native PDF handling is inconsistent across providers, and preserving only the visible utterance loses document content on the next Talk turn even when the first answer succeeded.

**How to apply:** when changing attachment or Talk persistence, check the next turn and reloaded history, not just the initial upload response. Do not introduce a shared document-content cache across workspaces.

Untrusted Node parsers need an OS address-space limit in addition to the V8 heap cap. Retain extraction capacity until the child exits.

**Why:** ArrayBuffers and native allocations bypass the V8 heap cap. Node and PDF.js also reserve substantial virtual mappings, so a virtual-memory limit equal to desired RSS can prevent ordinary documents from loading. Linux zombie children can lack RSS data before Node emits the exit event; treating that as a live monitoring failure masks valid parser errors.

**How to apply:** preserve a tested startup-compatible address-space cap and lower RSS monitoring threshold. Resource monitoring must distinguish running children from exited/zombie children, without treating an unreadable live process as safe.

Large extraction must remain linear in output size, and the isolated-worker protocol must tolerate backpressure.

**Why:** multi-megabyte results expose partial transport writes, while repeatedly scanning accumulated output becomes quadratic and can trip otherwise-correct resource guards.

**How to apply:** when raising extraction limits, verify large non-ASCII results across the process boundary and keep output accounting incremental.

Complete long-PDF summaries must advance only after every bounded text continuation for the current page batch is drained. Bind all batches to one stable, workspace-scoped file revision, and stop with explicit omissions if extraction truncates.

**Why:** a five-page parser selection can still exceed the per-action text window or the extractor output ceiling. Treating page selection as page coverage silently skips dense text, while reading changing revisions can combine different documents into one summary.

**How to apply:** keep direct targeted ranges exact; use signed revision-bound traversal state, persist rolling summaries between action rounds, enforce contiguous next-page requests, and never convert parser truncation into complete coverage.

Large PDF stdin must be read into one bounded backing store, then exposed to PDF.js as a fixed-length, full-span Uint8Array.

**Why:** Node's nonblocking pipe iterator creates many external Buffer allocations, and PDF.js copies partial-span views. Under RLIMIT_AS, either behavior can exhaust virtual memory for otherwise permitted 25–40 MB PDFs.

**How to apply:** retry EAGAIN at the pipe boundary, probe one byte past the inclusive limit, release unused buffer reservation before parsing, and regression-test the real child process at production-sized inputs.

Keep generated PDF regression text inside the page's media box.

**Why:** PDF.js can omit off-page glyphs from text extraction. A single long text line is not a reliable fixture for testing output truncation; it can appear to pass later-page isolation while never generating enough extracted text to hit the limit.

**How to apply:** use short lines with explicit positioning and a small font for dense-page fixtures, and assert the actual truncation marker through the bounded action executor.

Retained Talk documents need generation-bound cleanup, not unconditional deletion after asynchronous confirmation.

**Why:** a delayed confirmation cleanup for document A can otherwise erase a newer upload B even when both operations take the same lock. Serialization alone does not identify which context the user confirmed.

**How to apply:** preserve exact context versions across proposal, confirmation, dismissal and cleanup; keep a race test where a new upload precedes an older cleanup.

DOCX fixtures must use real WordprocessingML namespaces and deflated OPC packages.

**Why:** simplistic ZIP fixtures with invented namespaces can pass while real Word hyperlinks, drawings and tracked deletions are rejected or misread.

**How to apply:** cover strict/transitional namespaces, external hyperlink display text without dereferencing, and omitted revision/drawing content in parser regressions.
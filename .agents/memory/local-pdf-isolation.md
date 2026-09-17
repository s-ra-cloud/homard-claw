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

Complete long-PDF summaries must advance only after every bounded text continuation for the current page batch is drained. Direct reads stay small; the trusted summary path may use larger page and text chunks, with final-result space reserved for metadata.

**Why:** small public chunks make 600-page summaries exceed the round ceiling, but formatting a full internal chunk into an equally sized action result silently skips the truncated suffix when the cursor advances. Changing revisions can also combine different documents.

**How to apply:** keep direct targeted ranges exact; give summary-only chunks an independently validated hard cap and a larger replay envelope; bound Unicode text without splitting surrogates; use signed revision state, contiguous requests, and explicit omissions.

Retained PDF bytes may be reused only as a short-lived active-summary session bound to workspace, task, file, and exact revision. Each parser call must still start a fresh isolated child with the existing page, memory, byte, timeout, and cancellation bounds.

**Why:** re-downloading an unchanged large PDF for every text continuation wastes Drive bandwidth, but a reusable document cache would weaken tenant and revision isolation. Process restarts and parser failures must safely return to a verified download.

**How to apply:** re-check Drive metadata before every reuse, retain bytes only after a post-extraction revision check, cap and expire sessions promptly, and discard the session on parser failure, revision race, truncation, or final-page coverage.

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

Long-document traversal belongs to the server, not to model-selected continuation calls. Keep transport chunking separate from provider synthesis chunking, and derive prompt budgets from the entire provider request.

**Why:** larger extraction batches alone still spend a model turn per cursor and can exhaust the ordinary attempt deadline before reaching later pages. A page-range label does not prove that all text continuations from that range were synthesized.

**How to apply:** test a dense document whose batches require multiple text continuations; assert all extracted text reaches synthesis, not only first/last page markers. Use scalar offsets for transport and UTF-16 lengths for string-based prompt budgeting.

Long-job recovery must retain its original overall deadline and cumulative spend. A provider call with an ambiguous outcome must not be silently replayed.

**Why:** resetting limits on restart turns a finite job into an unbounded one; a crash between provider work and its durable result can otherwise cause duplicate billing. Preserving raw pending text and completed summaries is safer than treating an unknown outcome as success.

**How to apply:** distinguish safe checkpoint resumption from an in-flight provider ambiguity, preserve explicit owner limits, surface retained partial work and the actual stop reason, and keep each Codex synthesis serialized and sandboxed.

Do not invent a supposedly safe source size when a model's context window is unknown.

**Why:** fixed instructions, objective, pinned context, provider wrappers, and reserved output can already exhaust a small context before the document source is added. A small raw-text fallback alone does not make the complete request safe.

**How to apply:** require a verified model context for dedicated long-document synthesis, reserve the full request overhead, and check the actual request again before dispatch.
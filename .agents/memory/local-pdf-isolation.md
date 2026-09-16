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
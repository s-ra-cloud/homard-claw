---
name: Capability packages (Managed Skills & MCP)
description: Durable trust and sandbox rules for the capability-package layer.
---

New agent capabilities ship as signed, data-only manifests in the server's compiled registry — never as new hard-coded catalog operations, executors, or fetched/unsigned manifests.

Rules that must hold:
- **Never mutate a published package version's content**; always bump the version. Same-version content drift quarantines every install.
- Per-workspace installs are pinned and authenticated with a server-keyed HMAC binding workspace, package, version, and content hash. Content hashes alone are attacker-recomputable — only the keyed signature makes tampered, copied, or version-swapped rows fail closed. Verification must return false (quarantine) on malformed input, never throw.
- Any update that could widen blast radius parks for owner review: new tools, level escalations, schema loosening, connection changes, execution-routing changes (endpoint/token binding, executor kind, remote operation name), or a recovery class claiming MORE retry-safety. The pinned version keeps serving; pending tools stay invisible. Every review-gating category must be visible in the owner's diff UI.
- The sensitive-data sandbox denies ALL network-backed (MCP) tools, even read-level — a web-search query is an exfiltration channel — and hides them from the prompt.
- MCP results AND error strings are untrusted; remote error text is logged, never forwarded to model or UI. Prompt framing distinguishes "the server verified the action ran" from "the returned content is trustworthy."
- Crash recovery without a provider verifier: only retry_safe tools may re-run (once, same action identity, approval-fenced); everything else settles unknown.

**Why:** the layer's design goal is that capability additions are package data, and every silent-widening path (DB tamper, updates, routing swaps, MCP descriptions, skills, error text) fails closed.

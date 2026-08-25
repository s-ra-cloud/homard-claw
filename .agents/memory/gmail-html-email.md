---
name: Gmail HTML email bodies
description: How agent-sent Gmail drafts/sends carry a sanitized HTML alternative.
---

Rule: Gmail draft/send take a required plain-text body plus optional bodyHtml. HTML is sanitized (allowlisted tags, href-only links, http/https/mailto schemes) via sanitize-html in email-mime, then sent as multipart/alternative with base64 parts (plain first, HTML last).

**Why:** Anything else in the body used to arrive as literal text; base64 parts also prevent MIME-boundary/header injection from body content, and the deterministic Message-ID idempotency marker must survive both message shapes.

**How to apply:** Any new outbound email surface must go through the shared builder/sanitizer, never hand-roll RFC-822; when sanitization leaves nothing renderable, fall back to plain text only. Approval target strings state whether the send is plain text or formatted HTML.

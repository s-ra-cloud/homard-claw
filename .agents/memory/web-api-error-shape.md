---
name: Web client API error shape
description: How homardclaw pages must read errors thrown by the generated fetch client
---

The generated client (`lib/api-client-react`, `customFetch`) throws `ApiError` with the parsed body on `error.data` (our API always answers `{ error: string }`); `error.response` is the native Response. Pure network failures reject with the native fetch `TypeError` — no wrapper.

**Why:** several pages carried an obsolete axios-style `error.response?.data?.error` read, which matches nothing on `ApiError`, so every server error collapsed to a generic "Try again" toast and hid actionable API messages (this masked the deployed Codex memory-refresh failures).

**How to apply:** in homardclaw, use the shared helper `src/lib/api-error.ts` (`apiErrorMessage`) for toast messages — it surfaces `data.error`, gives proxy 502/503/504 responses and network failures useful fixed fallbacks. `ApiError`, `ResponseParseError`, and `customFetch` are exported from `@workspace/api-client-react`. Test error handling by driving the real generated client against stubbed `fetch` Responses, not hand-built error objects.

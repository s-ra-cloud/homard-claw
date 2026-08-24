---
name: Voice conversation architecture
description: Durable decisions behind talking to agents — provider split, task-confirmation security, degradation rules
---

Voice chat splits providers deliberately: speech-to-text and text-to-speech run through the Replit-managed OpenAI integration, while the agent's actual reply always comes from its own configured provider — the same brain that runs its tasks.

**Why:** agents must sound like themselves and stay subject to provider configuration/policy; the managed integration is only a mouth and ears. Its absence must degrade voice to text chat with a clear status, never crash the server (hence lazy-loading the speech module).

**How to apply:**
- Conversation endpoints must NEVER create tasks server-side. The model only *proposes* an objective; the client queues it through the normal task-creation route after explicit owner confirmation, so approval policy is preserved by construction and prompt injection can only alter visible text.
- Verbal confirmation must be an exact-phrase match on the utterance, not a substring test — "can you confirm the task?" is a question for the agent, not a confirmation.
- Sanitize provider failures to fixed messages; never echo upstream error bodies to the client.
- The live conversation path retries a retryable provider failure exactly once after a sub-second delay (an owner is waiting; the worker's minute-scale backoff is wrong here), and the wait must abort with the request. Terminal kinds (auth, not_configured, cancelled, timeout) never retry.
- Voice transcripts are opt-in and off by default; live captions (partial transcription while recording) are best-effort and never authoritative — the final server transcript of the full recording is.
- In the SSE turn stream, mark terminal failures as fatal so the client shows the real error instead of a generic "connection dropped"; non-fatal errors (e.g. TTS failure after a good reply) keep the turn alive.
- A disconnected client must cancel in-flight speech work (thread the abort signal into STT/TTS).

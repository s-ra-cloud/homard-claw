---
name: Chat question schedules
description: How scheduled Crustabot chat questions fire, separately from task schedules, and how the "awaiting reply" state is derived
---

Chat question schedules (`chatQuestionSchedulesTable`, `artifacts/api-server/src/chat-question-scheduler.ts`) are a sibling to task schedules (`schedulesTable`, `scheduler.ts`), not a variant of them: same one-time/recurring cadence shape and the same claim → dispatch → finalize discipline from `durable-scheduling.md`, but firing never dispatches a task — it inserts one `agentMessagesTable` row (`kind: "chat_question"`, `fromAgentId` = the schedule's agent) and best-effort mirrors it to Telegram if linked.

**Why a sibling table, not a `kind` column on `schedulesTable`:** `durable-scheduling.md` requires reusing the claim/finalize shape, but task-schedule behavior must stay untouched (explicit acceptance criterion on the feature). A separate table means the task scheduler's queries, indices, and tests are never at risk of a chat-question regression, at the cost of duplicating the claim/finalize scaffolding.

**How "awaiting the owner's reply" works:** there is no separate response-tracking table. The question is just another Talk message (kind `chat_question`, included alongside `kind: "voice"` everywhere Talk history is read — `routes/voice.ts` talk-history GET/DELETE, `telegram/service.ts` `telegramTalkHistory`), so the owner's next message in that same chat (web or Telegram) is trivially their answer through the existing Talk/Telegram plumbing. The `awaitingResponse` field on the API response is computed, not stored: `lastRunAt` is set and no owner-authored message (`fromAgentId IS NULL`) for that agent exists with a later `createdAt`.

**Evidence for claim recovery:** `agentMessagesTable.chatQuestionScheduleId` (nullable FK) is the link a crash-recovery pass checks — mirrors how the task scheduler checks `tasksTable.scheduleId`.

**How to apply:** any further chat-question-adjacent scheduling work should extend `chat-question-scheduler.ts`'s claim/finalize, not add new ad-hoc firing logic; and any new Talk history read site must include `"chat_question"` alongside `"voice"` or proactively-sent questions silently disappear from that surface.

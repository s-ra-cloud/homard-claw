import type { TalkUnreadSummary } from "@workspace/api-client-react";

export function unreadTalkAgentIds(
  summary: TalkUnreadSummary | undefined,
): Set<string> {
  return new Set(
    (summary?.agents ?? [])
      .filter((entry) => entry.unreadCount > 0)
      .map((entry) => entry.agentId),
  );
}
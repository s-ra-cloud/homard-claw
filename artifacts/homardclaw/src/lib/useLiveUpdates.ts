import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Live update subscription. The server streams topic hints over SSE
 * whenever tasks, approvals, notifications, agents, schedules, or the
 * office overview change; we invalidate the matching queries so React
 * Query refetches through the normal REST endpoints. The stream carries
 * no payloads — REST stays the single source of truth, and a dropped
 * connection only means falling back to each page's polling interval.
 */

const TOPIC_PREFIXES: Record<string, string[]> = {
  tasks: ["/api/tasks"],
  approvals: ["/api/approvals"],
  notifications: ["/api/notifications"],
  agents: ["/api/agents"],
  schedules: ["/api/schedules"],
  overview: ["/api/office/overview", "/api/runtime/health", "/api/reports/usage"],
};

export function useLiveUpdates(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 2_000;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(`${import.meta.env.BASE_URL}api/events`);
      source.onopen = () => {
        retryDelay = 2_000;
      };
      source.onmessage = (event) => {
        let topics: unknown;
        try {
          topics = (JSON.parse(event.data) as { topics?: unknown }).topics;
        } catch {
          return;
        }
        if (!Array.isArray(topics)) return;
        const prefixes = topics.flatMap((topic) =>
          typeof topic === "string" ? (TOPIC_PREFIXES[topic] ?? []) : [],
        );
        if (prefixes.length === 0) return;
        void queryClient.invalidateQueries({
          predicate: (query) => {
            const key = query.queryKey[0];
            return (
              typeof key === "string" &&
              prefixes.some((prefix) => key.startsWith(prefix))
            );
          },
        });
      };
      source.onerror = () => {
        // EventSource retries some failures itself; anything that closes
        // the stream gets an exponential-backoff reconnect from us.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);
}

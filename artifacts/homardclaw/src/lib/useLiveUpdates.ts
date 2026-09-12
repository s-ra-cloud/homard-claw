import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Live update subscription. The server streams topic hints over SSE
 * whenever tasks, approvals, notifications, agents, schedules, Talk, or the
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
  "chat-question-schedules": ["/api/chat-question-schedules"],
  talk: ["/api/agents/", "/api/talk-unread"],
  messages: ["/api/messages", "/api/agents/", "/api/talk-unread"],
  overview: [
    "/api/office/overview",
    "/api/runtime/health",
    "/api/reports/usage",
  ],
};

const ALL_LIVE_PREFIXES = [
  ...new Set(Object.values(TOPIC_PREFIXES).flat()),
];

type LiveUpdatesQueryClient = Pick<
  ReturnType<typeof useQueryClient>,
  "invalidateQueries"
>;

type VisibilityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

type EventStream = Pick<
  EventSource,
  "readyState" | "close" | "onopen" | "onmessage" | "onerror"
>;

interface LiveUpdatesDependencies {
  document: VisibilityDocument;
  createEventSource: (url: string) => EventStream;
  eventSourceClosed: number;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  baseUrl: string;
}

/**
 * Own one visible-tab stream and rehydrate caches after every known gap.
 * Exported so lifecycle behavior can be covered without a browser renderer.
 */
export function subscribeToLiveUpdates(
  queryClient: LiveUpdatesQueryClient,
  dependencies: LiveUpdatesDependencies,
): () => void {
  const {
    document,
    createEventSource,
    eventSourceClosed,
    setTimeout,
    clearTimeout,
    baseUrl,
  } = dependencies;
  let source: EventStream | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 2_000;
  let closed = false;

  const invalidatePrefixes = (prefixes: string[]): void => {
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

  const connect = (refreshAfterGap = false): void => {
    if (closed || document.visibilityState === "hidden" || source) return;
    if (refreshAfterGap) invalidatePrefixes(ALL_LIVE_PREFIXES);
    source = createEventSource(`${baseUrl}api/events`);
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
      invalidatePrefixes(
        topics.flatMap((topic) =>
          typeof topic === "string" ? (TOPIC_PREFIXES[topic] ?? []) : [],
        ),
      );
    };
    source.onerror = () => {
      if (source?.readyState === eventSourceClosed) {
        source.close();
        source = null;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect(true);
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      source?.close();
      source = null;
    } else {
      retryDelay = 2_000;
      connect(true);
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  connect();

  return () => {
    closed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (retryTimer) clearTimeout(retryTimer);
    source?.close();
  };
}

export function useLiveUpdates(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeToLiveUpdates(queryClient, {
      document,
      createEventSource: (url) => new EventSource(url),
      eventSourceClosed: EventSource.CLOSED,
      setTimeout,
      clearTimeout,
      baseUrl: import.meta.env.BASE_URL,
    });
  }, [queryClient]);
}

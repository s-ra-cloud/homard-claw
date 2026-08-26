import { EventEmitter } from "node:events";

/**
 * In-process live-update bus. The API server and the task worker share one
 * process (the worker is the advisory-lock singleton inside this server),
 * so an EventEmitter is sufficient: every state change either happens in a
 * route handler here or in the worker here. Subscribers are SSE connections
 * that forward topic invalidation hints to the browser; the client then
 * refetches through the normal REST endpoints, so the bus never carries
 * payloads — only "something under this topic changed".
 *
 * Every announcement is tagged with the workspace whose data changed, and
 * each SSE subscriber only receives announcements for its own workspace, so
 * one user's activity is never observable from another user's browser.
 */

export type LiveTopic =
  | "tasks"
  | "approvals"
  | "notifications"
  | "agents"
  | "schedules"
  | "talk"
  | "overview";

const bus = new EventEmitter();
// Many concurrent dashboard tabs each hold one listener.
bus.setMaxListeners(200);

const EVENT = "topics";

type Announcement = { workspaceId: string; topics: LiveTopic[] };

/**
 * Announce that a workspace's data under the given topics changed. A null
 * workspace (a legacy row the startup backfill has not stamped yet) is a
 * no-op rather than a broadcast: no other user should see the hint.
 */
export function publish(
  workspaceId: string | null | undefined,
  ...topics: LiveTopic[]
): void {
  if (workspaceId && topics.length > 0)
    bus.emit(EVENT, { workspaceId, topics } satisfies Announcement);
}

/**
 * Subscribe to topic announcements for one workspace only; returns an
 * unsubscribe function.
 */
export function subscribe(
  workspaceId: string,
  listener: (topics: LiveTopic[]) => void,
): () => void {
  const wrapped = (announcement: Announcement): void => {
    if (announcement.workspaceId === workspaceId) listener(announcement.topics);
  };
  bus.on(EVENT, wrapped);
  return () => bus.off(EVENT, wrapped);
}

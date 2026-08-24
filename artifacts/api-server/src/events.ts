import { EventEmitter } from "node:events";

/**
 * In-process live-update bus. The API server and the task worker share one
 * process (the worker is the advisory-lock singleton inside this server),
 * so an EventEmitter is sufficient: every state change either happens in a
 * route handler here or in the worker here. Subscribers are SSE connections
 * that forward topic invalidation hints to the browser; the client then
 * refetches through the normal REST endpoints, so the bus never carries
 * payloads — only "something under this topic changed".
 */

export type LiveTopic =
  | "tasks"
  | "approvals"
  | "notifications"
  | "agents"
  | "schedules"
  | "overview";

const bus = new EventEmitter();
// Many concurrent dashboard tabs each hold one listener.
bus.setMaxListeners(100);

const EVENT = "topics";

/** Announce that data under the given topics changed. Never throws. */
export function publish(...topics: LiveTopic[]): void {
  if (topics.length > 0) bus.emit(EVENT, topics);
}

/** Subscribe to topic announcements; returns an unsubscribe function. */
export function subscribe(listener: (topics: LiveTopic[]) => void): () => void {
  bus.on(EVENT, listener);
  return () => bus.off(EVENT, listener);
}

import { Router, type IRouter } from "express";
import { subscribe, type LiveTopic } from "../events";

const router: IRouter = Router();

/**
 * Live update stream. Emits `data: {"topics":[...]}` hints whenever server
 * state changes; the client invalidates the matching queries and refetches
 * through REST. Batches rapid-fire publishes into one message per ~250ms
 * so a busy worker tick cannot flood slow connections, and heartbeats
 * every 25s so proxies do not reap idle streams.
 */
router.get("/events", (req, res): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  res.flushHeaders?.();

  const pending = new Set<LiveTopic>();
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    flushTimer = null;
    if (pending.size === 0) return;
    const topics = [...pending];
    pending.clear();
    res.write(`data: ${JSON.stringify({ topics })}\n\n`);
  };
  const unsubscribe = subscribe((topics) => {
    for (const topic of topics) pending.add(topic);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 250);
      flushTimer.unref();
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);
  heartbeat.unref();

  req.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
  });
});

export default router;

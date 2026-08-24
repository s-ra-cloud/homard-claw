import { pool } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { abortAllInFlight, startWorker, stopWorker } from "./worker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // The task queue lives in Postgres. The worker acquires a cluster-wide
  // lease, recovers anything that was mid-flight when the previous holder
  // died, then starts claiming work.
  startWorker();
});

/**
 * Graceful shutdown (autoscale sends SIGTERM before killing the instance).
 * Order matters:
 *  1. Abort in-flight provider calls while we still hold the worker lease —
 *     their abort handlers append a log and settle agent status, which is
 *     only safe while no other instance can have reclaimed the task.
 *  2. Give those abort handlers a moment to settle, then release the lease
 *     so the next holder's recovery pass can requeue interrupted tasks.
 *  3. Close the HTTP server AND force-terminate held-open connections —
 *     /api/events keeps SSE sockets open indefinitely, so a bare
 *     server.close() would never finish.
 *  4. Drain the pool. A watchdog force-exits if anything wedges.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  const watchdog = setTimeout(() => {
    logger.error("Shutdown watchdog fired; exiting hard");
    process.exit(1);
  }, 10_000);
  watchdog.unref();

  try {
    const aborted = abortAllInFlight("shutdown");
    if (aborted > 0) {
      logger.warn({ aborted }, "Aborted in-flight provider calls");
      // Let the abort handlers finish their (fenced) bookkeeping writes
      // before we release the lease and drain the pool.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    stopWorker();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // SSE clients hold connections open forever; terminate them so
      // close() can complete.
      server.closeAllConnections();
    });

    await pool.end();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Shutdown cleanup failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

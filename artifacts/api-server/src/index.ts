import { pool } from "@workspace/db";
import app from "./app";
import { logGithubCredentialStartupHealth } from "./github/credentials";
import { githubAppConfigStatus } from "./github/app-auth";
import { logger } from "./lib/logger";
import { abortAllInFlight, startWorker, stopWorker } from "./worker";
import { ensureWorkspaceBackfill } from "./workspace";
import {
  registerTelegramWebhook,
  telegramFeatureStatus,
} from "./telegram/client";

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

  // Telegram is infrastructure-configured. When either required secret is
  // absent, do not contact Telegram at all; the UI reports it unavailable.
  if (telegramFeatureStatus().available) {
    registerTelegramWebhook()
      .then((result) => {
        if (result.registered) {
          logger.info("Telegram webhook registered");
        } else {
          logger.warn(
            { reason: result.reason },
            "Telegram webhook not registered",
          );
        }
      })
      .catch((error) => {
        logger.warn(
          {
            failureKind:
              error instanceof Error ? error.constructor.name : "UnknownError",
          },
          "Telegram webhook registration failed",
        );
      });
  }

  // Legacy single-owner data must belong to the owner's workspace before
  // any request or worker claim can rely on workspace scoping. Fail loudly
  // but keep serving: the backfill is idempotent and retried on next boot.
  // Deployment-configuration canary: prove stored GitHub credentials are
  // still decryptable with the current SESSION_SECRET, so a rotated or lost
  // secret shows up in deployment logs at boot (as an explicit
  // encryption-key mismatch) instead of as mystery auth failures later.
  // Fire-and-forget: diagnostics never block serving.
  logGithubCredentialStartupHealth().catch((err) => {
    logger.warn({ err }, "GitHub credential startup check failed");
  });
  // Same canary for the GitHub App identity: settings that are PRESENT but
  // unusable silently downgrade every workspace to the expiring OAuth path
  // and disable hands-free recovery — say so at boot, in deployment logs.
  if (githubAppConfigStatus() === "invalid") {
    logger.error(
      { component: "github_app", failureClass: "app_config_invalid" },
      "GitHub App settings are present but unusable (GITHUB_APP_ID, GITHUB_APP_SLUG, and GITHUB_APP_PRIVATE_KEY must all be set, and the key must be a readable PEM). Installation tokens and automatic GitHub recovery are DISABLED until this is fixed.",
    );
  }

  ensureWorkspaceBackfill()
    .catch((err) => {
      logger.error({ err }, "Workspace backfill failed");
    })
    .finally(() => {
      // The task queue lives in Postgres. The worker acquires expiring,
      // heartbeated cluster-wide ownership (taking over automatically when
      // a previous holder stops renewing), recovers anything that was
      // mid-flight when the previous holder died, then starts claiming.
      startWorker();
    });
});

/**
 * Graceful shutdown (autoscale sends SIGTERM before killing the instance).
 * Order matters:
 *  1. Abort in-flight provider calls while we still hold the worker lease —
 *     their abort handlers append a log and settle agent status, which is
 *     only safe while no other instance can have reclaimed the task.
 *  2. Give those abort handlers a moment to settle, then release queue
 *     ownership so the next holder can take over immediately (instead of
 *     waiting out the TTL) and requeue interrupted tasks.
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
      // before we release ownership and drain the pool.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await stopWorker();

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

import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Unauthenticated readiness probe (deployment health checks hit it before
 * traffic is routed). It verifies the database answers within a short
 * deadline: every feature in this app is Postgres-backed, so an "ok" with
 * a dead database would be a lie that routes traffic into a 500 wall.
 */
router.get("/healthz", async (_req, res) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database probe timed out")),
          2500,
        );
      }),
    ]);
    res.json(HealthCheckResponse.parse({ status: "ok" }));
  } catch {
    // No detail on purpose: this endpoint is public.
    res.status(503).json({ status: "unavailable" });
  } finally {
    clearTimeout(timer);
  }
});

export default router;

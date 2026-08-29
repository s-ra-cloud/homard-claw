import { pool } from "@workspace/db";

// The whole api-server suite runs against the shared dev Postgres. Two
// suite runs executing at the same time (e.g. a validation gate and a
// reviewer's verification run) interleave on the same owner workspace:
// credential snapshots restore over each other, queue recovery steals the
// other run's tasks, and codex leases collide. A session-scoped advisory
// lock held for the lifetime of the run makes concurrent runs queue up
// instead of interleaving.
//
// Keyspace note: single-key advisory locks map to (0, key) in the two-int
// keyspace, so this cannot collide with the app's (872_00x, hashtext(...))
// transaction-scoped locks. See the advisory-lock key registry.
const SUITE_LOCK_CLASS = 872_008;
const SUITE_LOCK_KEY = 0;
const WAIT_LIMIT_MS = 5 * 60_000;
const POLL_MS = 2_000;

export default async function globalSetup(): Promise<() => Promise<void>> {
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    for (;;) {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [SUITE_LOCK_CLASS, SUITE_LOCK_KEY],
      );
      if (res.rows[0]?.locked) break;
      if (Date.now() - startedAt > WAIT_LIMIT_MS) {
        throw new Error(
          "Timed out waiting for the api-server suite lock; another test-suite run against the shared database is still holding it.",
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        "[test-global-setup] waiting for another suite run against the shared database to finish...",
      );
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } catch (err) {
    client.release();
    await pool.end();
    throw err;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        SUITE_LOCK_CLASS,
        SUITE_LOCK_KEY,
      ]);
    } finally {
      client.release();
      await pool.end();
    }
  };
}

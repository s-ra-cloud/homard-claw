import { db, tasksTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { callProvider, type ProviderCallRequest } from "../execution";
import { availableProviderIds, isConfigured, providerLabel } from "../providers";

/**
 * Execution runtimes.
 *
 * A runtime is whatever actually performs a task's work. The office ships
 * with the built-in `native` runtime, which calls the configured model
 * provider directly. Everything the rest of the server needs from a
 * runtime goes through the adapter interface below, so another engine can
 * be registered later without touching agents, tasks, memories,
 * permissions, or the API contract.
 *
 * `openclaw` is registered as a KNOWN BUT UNINSTALLED runtime: it reports
 * its real status (not installed) and refuses to execute. Nothing selects
 * it, and it never pretends to be running.
 */

export const RUNTIME_IDS = ["native", "openclaw"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export const DEFAULT_RUNTIME: RuntimeId = "native";

/**
 * ready       — installed, configured, and able to accept work now.
 * degraded    — installed but missing something (e.g. no provider credential).
 * not_installed — the runtime's software is not present in this workspace.
 */
export type RuntimeStatus = "ready" | "degraded" | "not_installed";

export type RuntimeHealth = {
  id: RuntimeId;
  label: string;
  status: RuntimeStatus;
  /** Owner-facing sentence explaining the status. */
  detail: string;
  /** Whether the worker may dispatch tasks to this runtime right now. */
  acceptsWork: boolean;
};

export type RuntimeExecuteInput = ProviderCallRequest;

export class RuntimeUnavailableError extends Error {
  constructor(
    readonly runtimeId: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly label: string;
  health(): Promise<RuntimeHealth>;
  execute(
    input: RuntimeExecuteInput,
  ): ReturnType<typeof callProvider>;
}

/** The built-in runner: model provider calls made by this server. */
const nativeRuntime: RuntimeAdapter = {
  id: "native",
  label: "Built-in runtime",
  async health() {
    const configured = availableProviderIds()
      .filter((provider) => isConfigured(provider))
      .map((provider) => providerLabel(provider));
    if (configured.length === 0) {
      return {
        id: "native",
        label: this.label,
        status: "degraded",
        detail:
          "No model provider is configured yet, so tasks cannot run. Add a provider credential on the Providers page.",
        acceptsWork: true,
      };
    }
    return {
      id: "native",
      label: this.label,
      status: "ready",
      detail: `Running tasks in this server with ${configured.join(" and ")}.`,
      acceptsWork: true,
    };
  },
  execute(input) {
    return callProvider(input);
  },
};

/**
 * Placeholder for the external OpenClaw gateway. It is deliberately inert:
 * the software is not installed here, so it reports that plainly and
 * refuses work rather than silently falling back to the native runtime.
 */
const openclawRuntime: RuntimeAdapter = {
  id: "openclaw",
  label: "OpenClaw gateway",
  async health() {
    return {
      id: "openclaw",
      label: this.label,
      status: "not_installed",
      detail:
        "OpenClaw is not installed in this workspace. Tasks run on the built-in runtime; this adapter is the connection point for a future OpenClaw gateway.",
      acceptsWork: false,
    };
  },
  async execute() {
    throw new RuntimeUnavailableError(
      "openclaw",
      "The OpenClaw runtime is not installed in this workspace, so it cannot run tasks.",
    );
  },
};

const RUNTIMES: Record<RuntimeId, RuntimeAdapter> = {
  native: nativeRuntime,
  openclaw: openclawRuntime,
};

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a task's runtime. An unknown id is a configuration error rather
 * than a reason to run the work somewhere unintended, so it throws.
 */
export function getRuntime(id: string): RuntimeAdapter {
  if (!isRuntimeId(id)) {
    throw new RuntimeUnavailableError(id, `Unknown execution runtime "${id}".`);
  }
  return RUNTIMES[id];
}

export async function listRuntimeHealth(): Promise<RuntimeHealth[]> {
  return Promise.all(RUNTIME_IDS.map((id) => RUNTIMES[id].health()));
}

export type QueueHealth = {
  queued: number;
  running: number;
  waitingApproval: number;
  blocked: number;
  /** Age in seconds of the oldest task still waiting to start. */
  oldestQueuedSeconds: number | null;
};

/** Durable queue depth, straight from the tasks table. */
export async function queueHealth(): Promise<QueueHealth> {
  const [counts] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${tasksTable.status} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${tasksTable.status} = 'running')::int`,
      waitingApproval: sql<number>`count(*) filter (where ${tasksTable.status} = 'waiting_approval')::int`,
      blocked: sql<number>`count(*) filter (where ${tasksTable.status} = 'blocked')::int`,
      oldestQueuedSeconds: sql<
        number | null
      >`extract(epoch from (now() - min(${tasksTable.createdAt}) filter (where ${tasksTable.status} = 'queued')))::float`,
    })
    .from(tasksTable)
    .where(
      inArray(tasksTable.status, [
        "queued",
        "running",
        "waiting_approval",
        "blocked",
      ]),
    );
  return {
    queued: counts?.queued ?? 0,
    running: counts?.running ?? 0,
    waitingApproval: counts?.waitingApproval ?? 0,
    blocked: counts?.blocked ?? 0,
    oldestQueuedSeconds:
      counts?.oldestQueuedSeconds != null
        ? Math.round(counts.oldestQueuedSeconds)
        : null,
  };
}

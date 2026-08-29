import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The capability-package contract: signed, versioned, data-only manifests
 * that combine skill instructions with tool declarations. A manifest never
 * carries code — built-in tools reference existing vetted executors by
 * operation name, and MCP tools reference a remote server the package
 * declares. Nothing in a manifest can widen what the surrounding pipeline
 * (grants, sandbox, approvals, audit, budgets) allows; it can only describe
 * tools that pipeline will police. Native executors still carry only a
 * handler name; the implementation lives in an explicit server allowlist.
 */

export const CAPABILITY_RECOVERY_CLASSES = [
  /** Safe to run again after an interruption (idempotent reads/queries). */
  "retry_safe",
  /** The provider can be asked whether the write landed (idempotency marker). */
  "provider_verifiable",
  /** Never replayed: an ambiguous interruption settles as unknown. */
  "non_retryable",
] as const;
export type CapabilityRecoveryClass =
  (typeof CAPABILITY_RECOVERY_CLASSES)[number];

export type CapabilityParamSpec = {
  name: string;
  required: boolean;
  kind: "string" | "number";
  maxLength?: number;
  /** Only body/content-style params may contain newlines (header-injection gate). */
  multiline?: boolean;
};

export type CapabilityToolDef = {
  /** Stable fully-qualified name the model uses, e.g. "web_research.search". */
  name: string;
  description: string;
  /** read < draft < write; write always passes the owner approval desk. */
  level: "read" | "draft" | "write";
  params: CapabilityParamSpec[];
  /** Human "what/where" template; {param} placeholders are interpolated. */
  targetTemplate: string;
  recovery: CapabilityRecoveryClass;
  /** Hard cap on the characters of tool output fed back to the model. */
  resultCharLimit?: number;
  timeoutMs?: number;
  executor:
    | { kind: "builtin" }
    | {
        kind: "mcp";
        /** Tool name on the remote MCP server (pinned at review time). */
        remoteName: string;
      }
    | {
        kind: "native";
        /** Name resolved by vetted server code. A manifest never carries code. */
        handler: string;
      }
    | {
        kind: "custom_api";
        /** The workspace-owned custom_api_connections row this tool renders from. */
        connectionId: string;
        /** Operation id inside the connection's saved operation catalog. */
        operationId: string;
      };
};

export type CapabilitySkillDef = {
  id: string;
  title: string;
  /** Case-insensitive keywords; a skill is offered only when one matches the objective. */
  triggers: string[];
  /** Data-only guidance. Injected as clearly-labeled package guidance, never policy. */
  instructions: string;
};

export type CapabilityMcpServer = {
  /** Env var holding the HTTPS endpoint. The URL itself never lives in a manifest or prompt. */
  urlEnv: string;
  /** Optional env var holding a bearer token; sent as a header, never surfaced anywhere. */
  authTokenEnv?: string;
};

export type CapabilityManifest = {
  id: string;
  displayName: string;
  version: string;
  description: string;
  publisher: string;
  /** Which credential the tools need: an OAuth app, an MCP endpoint, or none. */
  connection: "gmail" | "google_drive" | "github" | "mcp" | "none";
  mcpServer?: CapabilityMcpServer;
  skills: CapabilitySkillDef[];
  tools: CapabilityToolDef[];
  /** Built-ins are implicitly installed and cannot be uninstalled. */
  builtin: boolean;
};

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function manifestFingerprint(manifest: CapabilityManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
}

/**
 * Registry signing. There is no external PKI here: the trust anchor is the
 * server build itself, and the signature binds a manifest to this registry
 * scheme so a manifest jsonb blob pasted from anywhere else fails
 * verification. Arbitrary unsigned manifests are out of scope by design.
 */
const REGISTRY_SIGNING_CONTEXT = "homardclaw-capability-registry-v1";

export function signManifest(manifest: CapabilityManifest): string {
  return createHash("sha256")
    .update(`${REGISTRY_SIGNING_CONTEXT}|${manifestFingerprint(manifest)}`)
    .digest("hex");
}

export function verifyManifestSignature(
  manifest: CapabilityManifest,
  signature: string,
): boolean {
  return signManifest(manifest) === signature;
}

/**
 * Install-row authentication. The registry hash above proves a manifest came
 * from THIS build's registry scheme, but anyone who can write the DB row can
 * recompute it. Install rows therefore also carry an HMAC under the server's
 * session secret, binding workspace + package + version + fingerprint: a DB
 * actor cannot forge it, and a signed row copied to another workspace or
 * repointed at a different version fails verification.
 */
const INSTALL_SIGNING_CONTEXT = "homardclaw-capability-install-v1";

function installSigningKey(): string | null {
  const key = process.env.SESSION_SECRET;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function signInstallRow(fields: {
  workspaceId: string;
  packageId: string;
  version: string;
  fingerprint: string;
}): string | null {
  const key = installSigningKey();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(
      `${INSTALL_SIGNING_CONTEXT}|${fields.workspaceId}|${fields.packageId}|${fields.version}|${fields.fingerprint}`,
    )
    .digest("hex");
}

export function verifyInstallSignature(
  fields: {
    workspaceId: string;
    packageId: string;
    version: string;
    fingerprint: string;
  },
  signature: string,
): boolean {
  const expected = signInstallRow(fields);
  // Strictly a 64-char lowercase hex digest: anything else (wrong length,
  // non-ASCII, junk) is simply an invalid signature — return false, never
  // throw, so a malformed DB row quarantines instead of crashing resolution.
  if (!expected || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Interpolate {param} placeholders; missing params render as "?". */
export function renderTargetTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  return template
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = params[key];
      return value === undefined || value === null ? "?" : String(value);
    })
    .slice(0, 300);
}

/**
 * What changed, permission-wise, between the pinned manifest and a newer
 * registry version. Anything that could widen blast radius — new tools,
 * level escalations, loosened schemas, weaker recovery classes, a changed
 * connection — makes the update "expanding": it parks in update_review and
 * activates only after the owner accepts the diff.
 */
export type CapabilityPermissionDiff = {
  addedTools: { name: string; level: string; description: string }[];
  removedTools: string[];
  levelChanges: { name: string; from: string; to: string }[];
  recoveryChanges: { name: string; from: string; to: string }[];
  schemaChanges: string[];
  connectionChange: { from: string; to: string } | null;
  /**
   * Execution-routing changes: the package's MCP server binding (endpoint or
   * token env var), a tool's executor kind, or a tool's remote MCP operation
   * name. Moving from MCP to a vetted native handler (and dropping its MCP
   * binding) is a contraction and is recorded here without counting as an
   * expansion; all other routing changes require owner review.
   */
  routingChanges: string[];
  expandsPermissions: boolean;
};

const LEVEL_RANK: Record<string, number> = { read: 0, draft: 1, write: 2 };
const RECOVERY_RANK: Record<CapabilityRecoveryClass, number> = {
  retry_safe: 0,
  provider_verifiable: 1,
  non_retryable: 2,
};

/**
 * One reviewed routing contraction: Web Research 1.0's two MCP operations
 * move to their exact compiled 2.0 handlers. Keeping this allowlist narrow
 * prevents a future arbitrary MCP → native rebind from silently auto-applying.
 */
function isWebResearchNativeMigration(
  from: CapabilityManifest,
  to: CapabilityManifest,
): boolean {
  if (
    from.id !== "web_research" ||
    to.id !== "web_research" ||
    from.version !== "1.0.0" ||
    to.version !== "2.0.0" ||
    from.connection !== "mcp" ||
    to.connection !== "none" ||
    to.mcpServer !== undefined
  ) {
    return false;
  }
  const expectedHandlers = new Map([
    ["web_research.search", ["search", "web.search"]],
    ["web_research.fetch", ["fetch", "web.fetch"]],
  ]);
  if (
    from.tools.length !== expectedHandlers.size ||
    to.tools.length !== expectedHandlers.size
  ) {
    return false;
  }
  return to.tools.every((tool) => {
    const previous = from.tools.find(
      (candidate) => candidate.name === tool.name,
    );
    const expected = expectedHandlers.get(tool.name);
    return (
      previous !== undefined &&
      expected !== undefined &&
      previous.executor.kind === "mcp" &&
      previous.executor.remoteName === expected[0] &&
      tool.executor.kind === "native" &&
      tool.executor.handler === expected[1] &&
      previous.level === tool.level &&
      previous.recovery === tool.recovery &&
      JSON.stringify(canonicalize(previous.params)) ===
        JSON.stringify(canonicalize(tool.params))
    );
  });
}

/** Human-readable destination for one executor, used in review diffs. */
function describeExecutor(executor: CapabilityToolDef["executor"]): string {
  switch (executor.kind) {
    case "mcp":
      return `mcp:${executor.remoteName}`;
    case "native":
      return `native:${executor.handler}`;
    case "custom_api":
      return `custom_api:${executor.operationId}`;
    default:
      return executor.kind;
  }
}

export function computePermissionDiff(
  from: CapabilityManifest,
  to: CapabilityManifest,
): CapabilityPermissionDiff {
  const before = new Map(from.tools.map((t) => [t.name, t]));
  const after = new Map(to.tools.map((t) => [t.name, t]));
  const diff: CapabilityPermissionDiff = {
    addedTools: [],
    removedTools: [],
    levelChanges: [],
    recoveryChanges: [],
    schemaChanges: [],
    connectionChange:
      from.connection === to.connection
        ? null
        : { from: from.connection, to: to.connection },
    routingChanges: [],
    expandsPermissions: false,
  };
  const vettedNativeMigration = isWebResearchNativeMigration(from, to);
  let routingExpands = false;
  const connectionExpands =
    diff.connectionChange !== null && !vettedNativeMigration;
  // The MCP server binding is part of the routing surface: pointing the same
  // tools at a different endpoint (or auth) env var is a review-gating change.
  if (
    (from.mcpServer?.urlEnv ?? null) !== (to.mcpServer?.urlEnv ?? null) ||
    (from.mcpServer?.authTokenEnv ?? null) !==
      (to.mcpServer?.authTokenEnv ?? null)
  ) {
    diff.routingChanges.push(
      `${to.id}: MCP server binding changed (${from.mcpServer?.urlEnv ?? "none"} → ${to.mcpServer?.urlEnv ?? "none"})`,
    );
    // Removing a remote MCP binding while moving to a server-vetted native
    // handler narrows routing. Adding or changing a remote binding does not.
    if (!vettedNativeMigration) routingExpands = true;
  }
  for (const [name, tool] of after) {
    const prev = before.get(name);
    if (!prev) {
      diff.addedTools.push({
        name,
        level: tool.level,
        description: tool.description,
      });
      continue;
    }
    if (prev.level !== tool.level) {
      diff.levelChanges.push({ name, from: prev.level, to: tool.level });
    }
    if (prev.recovery !== tool.recovery) {
      diff.recoveryChanges.push({
        name,
        from: prev.recovery,
        to: tool.recovery,
      });
    }
    if (
      JSON.stringify(canonicalize(prev.params)) !==
      JSON.stringify(canonicalize(tool.params))
    ) {
      diff.schemaChanges.push(name);
    }
    // Executor routing changes are review-gating except MCP → native: the
    // latter replaces a remote endpoint with a compiled server allowlist.
    if (prev.executor.kind !== tool.executor.kind) {
      // Name the concrete destination on both sides so an owner reviewing
      // the diff sees WHERE calls would now go, not just the executor kind.
      diff.routingChanges.push(
        `${name}: executor changed (${describeExecutor(prev.executor)} → ${describeExecutor(tool.executor)})`,
      );
      if (!vettedNativeMigration) {
        routingExpands = true;
      }
    } else if (
      prev.executor.kind === "mcp" &&
      tool.executor.kind === "mcp" &&
      prev.executor.remoteName !== tool.executor.remoteName
    ) {
      diff.routingChanges.push(
        `${name}: remote operation changed (${prev.executor.remoteName} → ${tool.executor.remoteName})`,
      );
      routingExpands = true;
    } else if (
      prev.executor.kind === "native" &&
      tool.executor.kind === "native" &&
      prev.executor.handler !== tool.executor.handler
    ) {
      diff.routingChanges.push(
        `${name}: native handler changed (${prev.executor.handler} → ${tool.executor.handler})`,
      );
      routingExpands = true;
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) diff.removedTools.push(name);
  }
  diff.expandsPermissions =
    diff.addedTools.length > 0 ||
    diff.schemaChanges.length > 0 ||
    connectionExpands ||
    routingExpands ||
    diff.levelChanges.some(
      (c) => (LEVEL_RANK[c.to] ?? 99) > (LEVEL_RANK[c.from] ?? 0),
    ) ||
    diff.recoveryChanges.some(
      (c) =>
        (RECOVERY_RANK[c.from as CapabilityRecoveryClass] ?? 0) >
        (RECOVERY_RANK[c.to as CapabilityRecoveryClass] ?? 99),
    );
  return diff;
}

/** Structural validation of a manifest snapshot loaded back from the DB. */
export function isCapabilityManifest(
  value: unknown,
): value is CapabilityManifest {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (
    typeof m.id !== "string" ||
    typeof m.version !== "string" ||
    typeof m.displayName !== "string" ||
    typeof m.connection !== "string" ||
    !Array.isArray(m.tools) ||
    !Array.isArray(m.skills)
  ) {
    return false;
  }
  for (const tool of m.tools as unknown[]) {
    if (!tool || typeof tool !== "object") return false;
    const t = tool as Record<string, unknown>;
    if (
      typeof t.name !== "string" ||
      !["read", "draft", "write"].includes(t.level as string) ||
      !CAPABILITY_RECOVERY_CLASSES.includes(
        t.recovery as CapabilityRecoveryClass,
      ) ||
      !Array.isArray(t.params) ||
      typeof t.targetTemplate !== "string" ||
      !t.executor ||
      typeof t.executor !== "object"
    ) {
      return false;
    }
    const executor = t.executor as Record<string, unknown>;
    if (!(
      executor.kind === "builtin" ||
      (executor.kind === "mcp" && typeof executor.remoteName === "string") ||
      (executor.kind === "native" && typeof executor.handler === "string") ||
      (executor.kind === "custom_api" &&
        typeof executor.connectionId === "string" &&
        typeof executor.operationId === "string")
    )) {
      return false;
    }
  }
  return true;
}

/** MCP, native, and custom-API tools cross the no-network sandbox boundary. */
export function isNetworkBackedExecutor(
  executor: CapabilityToolDef["executor"],
): boolean {
  return (
    executor.kind === "mcp" ||
    executor.kind === "native" ||
    executor.kind === "custom_api"
  );
}

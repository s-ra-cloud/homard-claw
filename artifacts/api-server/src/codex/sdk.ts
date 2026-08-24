/**
 * Lazy, injectable access to the official Codex SDK.
 *
 * The SDK spawns the bundled `codex` CLI, so it is loaded through a dynamic
 * import: a workspace where the package failed to install reports "SDK
 * unavailable" instead of crashing the server at boot. Tests replace the
 * loader with a fake — no test ever reaches a real provider.
 *
 * The structural types below mirror the parts of `@openai/codex-sdk` this
 * server uses. They exist so a fake can satisfy the same shape.
 */

export type CodexUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "error"; message: string }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      item: CodexThreadItem;
    };

export type CodexThreadItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: "in_progress" | "completed" | "failed";
    }
  | {
      id: string;
      type: "file_change";
      changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
      status: "completed" | "failed";
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      status: string;
    }
  | { id: string; type: "web_search"; query: string }
  | { id: string; type: "todo_list"; items: Array<{ text: string; completed: boolean }> }
  | { id: string; type: "error"; message: string };

export type CodexThreadOptions = {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: string;
  networkAccessEnabled?: boolean;
  webSearchMode?: "disabled" | "cached" | "live";
  webSearchEnabled?: boolean;
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  additionalDirectories?: string[];
};

export type CodexThreadHandle = {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
};

export type CodexClient = {
  startThread(options?: CodexThreadOptions): CodexThreadHandle;
  resumeThread(id: string, options?: CodexThreadOptions): CodexThreadHandle;
};

export type CodexClientOptions = {
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type CodexSdk = {
  createClient(options: CodexClientOptions): CodexClient;
};

export class CodexSdkUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSdkUnavailableError";
  }
}

type Loader = () => Promise<CodexSdk>;

/**
 * The SDK is a thin wrapper: the real work happens in a platform-specific
 * `codex` binary shipped by `@openai/codex`. Bundlers routinely drop that
 * native package, and the failure only shows up mid-run as an opaque spawn
 * error. Resolving it up front turns that into an honest status message.
 *
 * Resolution starts from the SDK's *real* path because pnpm links packages
 * through a store: resolving from the symlink would miss the CLI that is
 * in fact installed right beside it.
 */
async function locateCodexCli(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { createRequire } = await import("node:module");
    const { realpathSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // The SDK's package.json is not in its `exports` map, so it cannot be
    // resolved by subpath. Resolve the module entry instead, then follow
    // the pnpm symlink to where the CLI is actually installed beside it.
    const entryUrl = import.meta.resolve("@openai/codex-sdk");
    const sdkEntry = realpathSync(fileURLToPath(entryUrl));
    const fromSdk = createRequire(sdkEntry);
    const cliPackageJson = fromSdk.resolve("@openai/codex/package.json");
    const fromCli = createRequire(cliPackageJson);
    const platform = `@openai/codex-${process.platform}-${process.arch}`;
    fromCli.resolve(`${platform}/package.json`);
    return { ok: true, detail: `Native Codex CLI present (${platform}).` };
  } catch {
    return {
      ok: false,
      detail:
        "The native Codex CLI (@openai/codex) is not installed for this platform, so the SDK has nothing to run. Reinstall dependencies on the deployment target and redeploy.",
    };
  }
}

const realLoader: Loader = async () => {
  let module: { Codex: new (options: CodexClientOptions) => CodexClient };
  try {
    // Kept dynamic: the package pulls a platform-specific CLI binary, and a
    // workspace missing it must degrade to a clear status message.
    module = (await import("@openai/codex-sdk")) as unknown as typeof module;
  } catch {
    throw new CodexSdkUnavailableError(
      "The official Codex SDK is not installed in this deployment, so Codex cannot run. Reinstall dependencies and redeploy.",
    );
  }
  if (typeof module?.Codex !== "function") {
    throw new CodexSdkUnavailableError(
      "The installed Codex SDK does not expose the expected client, so Codex cannot run.",
    );
  }
  return {
    createClient: (options) => new module.Codex(options),
  };
};

let loader: Loader = realLoader;

/** Test hook: swap in a fake SDK. Pass null to restore the real loader. */
export function setCodexSdkLoader(next: Loader | null): void {
  loader = next ?? realLoader;
}

export async function loadCodexSdk(): Promise<CodexSdk> {
  return loader();
}

/**
 * Whether the SDK *and* its native CLI are usable, without starting a
 * thread. Nothing here contacts OpenAI, so it can be called freely.
 */
export async function codexSdkAvailable(): Promise<{
  available: boolean;
  detail: string;
}> {
  try {
    await loadCodexSdk();
    // A swapped-in loader is a test fake with no CLI behind it; only the
    // real SDK needs the binary.
    if (loader !== realLoader) {
      return { available: true, detail: "Codex SDK loaded." };
    }
    const cli = await locateCodexCli();
    return { available: cli.ok, detail: cli.detail };
  } catch (error) {
    return {
      available: false,
      detail:
        error instanceof CodexSdkUnavailableError
          ? error.message
          : "The Codex SDK could not be loaded in this deployment.",
    };
  }
}

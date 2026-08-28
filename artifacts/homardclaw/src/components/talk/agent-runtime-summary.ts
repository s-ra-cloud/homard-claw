import type { Agent, ProviderSettings } from "@workspace/api-client-react";

const PROVIDER_LABELS = {
  claude_max: "Claude Code",
  codex_chatgpt: "Codex via ChatGPT",
  openrouter: "OpenRouter",
} as const;

const APP_LABELS: Record<string, string> = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  github: "GitHub",
  web_research: "Web Research",
};

function humanizeIdentifier(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface AgentRuntimeSummary {
  provider: string;
  model: string;
  apps: Array<{ app: string; accessLevel: string }>;
}

/**
 * Owner-facing runtime and app-access labels for the Talk header. Resolve
 * inherited workspace settings where they are known, but say "default"
 * instead of inventing a provider model when the server owns that choice.
 */
export function agentRuntimeSummary(
  agent: Agent,
  settings?: ProviderSettings,
): AgentRuntimeSummary {
  const providerId = agent.provider ?? settings?.defaultProvider ?? null;
  const providerName = providerId
    ? PROVIDER_LABELS[providerId]
    : "Workspace default";
  const provider =
    agent.provider === null && providerId
      ? `${providerName} (workspace)`
      : providerName;

  let model: string | null | undefined;
  if (providerId === "codex_chatgpt") {
    model = agent.codexModel?.trim() || settings?.codexModel?.trim();
  } else if (providerId === "claude_max") {
    model = agent.model?.trim() || settings?.claudeModel?.trim();
  } else if (providerId === "openrouter") {
    model = agent.model?.trim() || settings?.openrouterModel?.trim();
  } else {
    model = agent.model?.trim();
  }

  return {
    provider,
    model: model || "Provider default",
    apps: [...agent.appGrants]
      .sort((left, right) => left.app.localeCompare(right.app))
      .map((grant) => ({
        app: APP_LABELS[grant.app] ?? humanizeIdentifier(grant.app),
        accessLevel: grant.accessLevel,
      })),
  };
}

import type {
  Agent,
  ConnectedApp,
  ProviderSettings,
} from "@workspace/api-client-react";

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

export interface AgentReconnectWarning {
  connection: "google" | "github";
  service: "gmail" | "google_drive" | "google" | "github";
  label: string;
}

/**
 * Match this agent's grants to live authorization failures. Gmail and Drive
 * share one Google credential, so they are presented as one recovery action.
 * An unavailable inventory entry is deliberately ignored: it says nothing
 * about whether the owner's authorization was lost.
 */
export function agentReconnectWarnings(
  agent: Agent,
  apps: ConnectedApp[],
): AgentReconnectWarning[] {
  const granted = new Set(agent.appGrants.map((grant) => grant.app));
  const needsReconnect = (app: ConnectedApp | undefined) =>
    app?.enabled === true &&
    (app.status === "expired" || app.status === "not_connected");
  const byId = new Map(apps.map((app) => [app.app, app]));
  const affectedGoogle = (["gmail", "google_drive"] as const).filter(
    (app) => granted.has(app) && needsReconnect(byId.get(app)),
  );
  const warnings: AgentReconnectWarning[] = [];

  if (affectedGoogle.length > 0) {
    warnings.push({
      connection: "google",
      service:
        affectedGoogle.length === 2
          ? "google"
          : affectedGoogle.includes("google_drive")
            ? "google_drive"
            : "gmail",
      label: affectedGoogle
        .map((app) => APP_LABELS[app])
        .join(" and "),
    });
  }
  if (granted.has("github") && needsReconnect(byId.get("github"))) {
    warnings.push({
      connection: "github",
      service: "github",
      label: APP_LABELS.github,
    });
  }
  return warnings;
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

import { describe, expect, it } from "vitest";
import type { Agent, ProviderSettings } from "@workspace/api-client-react";
import { agentRuntimeSummary } from "./agent-runtime-summary";

const agent = {
  provider: "claude_max",
  model: "claude-sonnet-4-5",
  codexModel: null,
  appGrants: [
    { app: "gmail", accessLevel: "write" },
    { app: "google_drive", accessLevel: "read" },
  ],
} as Agent;

const settings = {
  defaultProvider: "codex_chatgpt",
  claudeModel: "workspace-claude",
  openrouterModel: "workspace-openrouter",
  codexModel: "gpt-5.6-terra",
} as ProviderSettings;

describe("Talk Crustabot runtime summary", () => {
  it("shows an explicitly configured provider, model, and every app level", () => {
    expect(agentRuntimeSummary(agent, settings)).toEqual({
      provider: "Claude Code",
      model: "claude-sonnet-4-5",
      apps: [
        { app: "Gmail", accessLevel: "write" },
        { app: "Google Drive", accessLevel: "read" },
      ],
    });
  });

  it("resolves the workspace provider and its provider-specific model", () => {
    expect(
      agentRuntimeSummary(
        {
          ...agent,
          provider: null,
          model: null,
          codexModel: null,
          appGrants: [],
        },
        settings,
      ),
    ).toEqual({
      provider: "Codex via ChatGPT (workspace)",
      model: "gpt-5.6-terra",
      apps: [],
    });
  });

  it("uses safe, readable fallbacks while workspace settings load", () => {
    expect(
      agentRuntimeSummary({
        ...agent,
        provider: null,
        model: null,
        appGrants: [{ app: "custom_research-tool", accessLevel: "draft" }],
      }).provider,
    ).toBe("Workspace default");
    expect(
      agentRuntimeSummary({
        ...agent,
        provider: null,
        model: null,
        appGrants: [{ app: "custom_research-tool", accessLevel: "draft" }],
      }).apps,
    ).toEqual([{ app: "Custom Research Tool", accessLevel: "draft" }]);
  });
});

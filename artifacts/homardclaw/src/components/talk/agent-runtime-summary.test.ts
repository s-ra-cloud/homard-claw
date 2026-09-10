import { describe, expect, it } from "vitest";
import type {
  Agent,
  ConnectedApp,
  ProviderSettings,
} from "@workspace/api-client-react";
import {
  agentReconnectWarnings,
  agentRuntimeSummary,
} from "./agent-runtime-summary";

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

const connectedApp = (
  app: ConnectedApp["app"],
  status: ConnectedApp["status"],
): ConnectedApp => ({
  app,
  status,
  displayName:
    app === "google_drive"
      ? "Google Drive"
      : app === "gmail"
        ? "Gmail"
        : "GitHub",
  enabled: true,
  statusDetail: null,
  accountLabel: null,
  grantedAgents: 1,
});

describe("Talk app reconnection warnings", () => {
  it("deduplicates broken Gmail and Drive grants into one Google action", () => {
    expect(
      agentReconnectWarnings(agent, [
        connectedApp("gmail", "expired"),
        connectedApp("google_drive", "not_connected"),
        connectedApp("github", "not_connected"),
      ]),
    ).toEqual([
      {
        connection: "google",
        service: "google",
        label: "Gmail and Google Drive",
      },
    ]);
  });

  it("shows independent Google and GitHub recovery actions when granted", () => {
    expect(
      agentReconnectWarnings(
        {
          ...agent,
          appGrants: [
            { app: "gmail", accessLevel: "read" },
            { app: "github", accessLevel: "write" },
          ],
        },
        [
          connectedApp("gmail", "not_connected"),
          connectedApp("google_drive", "connected"),
          connectedApp("github", "expired"),
        ],
      ),
    ).toEqual([
      { connection: "google", service: "gmail", label: "Gmail" },
      { connection: "github", service: "github", label: "GitHub" },
    ]);
  });

  it("ignores connected, unavailable, and ungranted services", () => {
    expect(
      agentReconnectWarnings(agent, [
        connectedApp("gmail", "connected"),
        connectedApp("google_drive", "unavailable"),
        connectedApp("github", "expired"),
      ]),
    ).toEqual([]);
  });

  it("ignores retained grants for apps disabled across the workspace", () => {
    expect(
      agentReconnectWarnings(agent, [
        { ...connectedApp("gmail", "expired"), enabled: false },
        { ...connectedApp("google_drive", "not_connected"), enabled: false },
      ]),
    ).toEqual([]);
  });
});

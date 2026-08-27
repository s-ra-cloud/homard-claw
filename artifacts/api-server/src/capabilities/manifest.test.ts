import { describe, expect, it } from "vitest";
import { computePermissionDiff, type CapabilityManifest } from "./manifest";

function webManifest(version: "1.0.0" | "2.0.0"): CapabilityManifest {
  const native = version === "2.0.0";
  return {
    id: "web_research",
    displayName: "Web Research",
    version,
    description: "Read-only web research.",
    publisher: "HomardClaw",
    connection: native ? "none" : "mcp",
    ...(native
      ? {}
      : {
          mcpServer: {
            urlEnv: "WEB_RESEARCH_MCP_URL",
            authTokenEnv: "WEB_RESEARCH_MCP_TOKEN",
          },
        }),
    skills: [],
    tools: [
      {
        name: "web_research.search",
        description: "Search",
        level: "read",
        params: [
          { name: "query", required: true, kind: "string", maxLength: 500 },
        ],
        targetTemplate: "Search {query}",
        recovery: "retry_safe",
        executor: native
          ? { kind: "native", handler: "web.search" }
          : { kind: "mcp", remoteName: "search" },
      },
      {
        name: "web_research.fetch",
        description: "Fetch",
        level: "read",
        params: [
          { name: "url", required: true, kind: "string", maxLength: 2000 },
        ],
        targetTemplate: "Fetch {url}",
        recovery: "retry_safe",
        executor: native
          ? { kind: "native", handler: "web.fetch" }
          : { kind: "mcp", remoteName: "fetch" },
      },
    ],
    builtin: false,
  };
}

describe("capability routing diffs", () => {
  it("auto-applies only the reviewed Web Research 1.0 MCP to 2.0 native migration", () => {
    const legacy = webManifest("1.0.0");
    const current = webManifest("2.0.0");
    const diff = computePermissionDiff(legacy, current);
    expect(diff.routingChanges.length).toBeGreaterThan(0);
    expect(diff.expandsPermissions).toBe(false);

    const unreviewed = webManifest("1.0.0");
    unreviewed.version = "0.9.9";
    expect(computePermissionDiff(unreviewed, current).expandsPermissions).toBe(
      true,
    );
  });

  it("requires review when a native handler name changes", () => {
    const before = webManifest("2.0.0");
    const after = structuredClone(before);
    after.version = "2.0.1";
    after.tools[0]!.executor = {
      kind: "native",
      handler: "web.unreviewed_search",
    };
    expect(computePermissionDiff(before, after).expandsPermissions).toBe(true);
  });
});

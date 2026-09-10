import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { unreadTalkAgentIds } from "./office-unread";

const dashboard = fs.readFileSync(
  new URL("./OfficeDashboard.tsx", import.meta.url),
  "utf8",
);
const styles = fs.readFileSync(
  new URL("./office-dashboard.css", import.meta.url),
  "utf8",
);

describe("office unread Talk bubbles", () => {
  it("renders a decorative bubble only for a placed agent with unread Talk", () => {
    expect(dashboard).toContain("unreadAgentIds.has(agent.id)");
    expect(dashboard).toContain('className="room-agent__unread-bubble"');
    expect(dashboard).toContain('aria-hidden="true"');
    expect(dashboard).toContain("…");
  });

  it("selects only unread agents and removes one after acknowledgement refetches", () => {
    const before = unreadTalkAgentIds({
      agents: [
        { agentId: "agent-a", unreadCount: 2 },
        { agentId: "agent-b", unreadCount: 0 },
      ],
    });
    expect([...before]).toEqual(["agent-a"]);

    const after = unreadTalkAgentIds({ agents: [] });
    expect(after.has("agent-a")).toBe(false);
  });

  it("keeps the bubble above the sprite without intercepting its link", () => {
    expect(styles).toMatch(
      /\.room-agent__unread-bubble\s*\{[^}]*z-index:\s*3;[^}]*pointer-events:\s*none;/s,
    );
  });

  it("points the bubble tail to the left", () => {
    expect(styles).toMatch(
      /\.room-agent__unread-bubble::after\s*\{[^}]*left:\s*4px;[^}]*border-left:\s*2px solid #2b2733;[^}]*}/s,
    );
    expect(styles).not.toMatch(
      /\.room-agent__unread-bubble::after\s*\{[^}]*border-right:\s*2px solid #2b2733;/s,
    );
  });
});
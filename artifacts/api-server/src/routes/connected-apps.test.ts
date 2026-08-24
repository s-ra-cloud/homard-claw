/**
 * Connected-app coverage:
 *  - the action parser only accepts explicit, well-formed blocks
 *  - the authorization deny matrix (unknown op, no grant, insufficient
 *    level, invalid params) and the write→approval rule
 *  - the /connected-apps inventory and the workspace-wide enable switch
 *  - agent grant CRUD: create with grants, replace on update, leave
 *    unchanged when omitted, and never copy grants on duplication
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md):
 * impersonate the existing owner, tag and clean up all created rows, never
 * clobber owner_clerk_id, and restore any shared setting rows we touch.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentAppGrantsTable,
  agentsTable,
  connectedAppSettingsTable,
  db,
  systemStateTable,
  tasksTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: "hc-apps-owner" as string | null,
  emails: {} as Record<string, string>,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async (id: string) => {
        const email = authState.emails[id];
        if (!email) throw new Error("no such user");
        return {
          primaryEmailAddress: {
            emailAddress: email,
            verification: { status: "verified" },
          },
        };
      },
    },
  },
}));

import officeRouter from "./office";
import { describeConnection } from "../connected-apps/connections";
import { parseAppActions } from "../connected-apps/parser";
import { authorizeAppAction } from "../connected-apps/authorize";
import { buildAppsPromptSection } from "../connected-apps/catalog";
import type { AppAccessLevel, ConnectedAppId } from "@workspace/db";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC Apps Test ${Date.now()}`;
const createdAgentIds: string[] = [];
let createdOwnerRow = false;
let ownerId = "hc-apps-owner";
/** app → original settings row (or null when there was none) to restore. */
const touchedSettings = new Map<string, { enabled: boolean } | null>();

function agentInput(name: string, extra: Record<string, unknown> = {}) {
  return {
    name: `${name} ${RUN_TAG}`,
    title: "Test Analyst",
    mission: "Exercise connected-app grants and report back.",
    provider: "claude_max",
    securityPreset: "assistant",
    avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    ...extra,
  };
}

async function createAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/agents")
    .send(agentInput(name, extra));
  if (res.status === 201) createdAgentIds.push(res.body.id);
  return res;
}

async function rememberSetting(appId: string) {
  if (touchedSettings.has(appId)) return;
  const [row] = await db
    .select()
    .from(connectedAppSettingsTable)
    .where(eq(connectedAppSettingsTable.app, appId))
    .limit(1);
  touchedSettings.set(appId, row ? { enabled: row.enabled } : null);
}

beforeAll(async () => {
  const [owner] = await db
    .select()
    .from(systemStateTable)
    .where(eq(systemStateTable.key, "owner_clerk_id"))
    .limit(1);
  if (owner) {
    ownerId = owner.value;
  } else {
    await db
      .insert(systemStateTable)
      .values({ key: "owner_clerk_id", value: ownerId });
    createdOwnerRow = true;
  }
  authState.userId = ownerId;
});

afterAll(async () => {
  // Restore any shared enable-switch rows exactly as we found them.
  for (const [appId, original] of touchedSettings) {
    if (original === null) {
      await db
        .delete(connectedAppSettingsTable)
        .where(eq(connectedAppSettingsTable.app, appId));
    } else {
      await db
        .insert(connectedAppSettingsTable)
        .values({ app: appId, enabled: original.enabled, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: connectedAppSettingsTable.app,
          set: { enabled: original.enabled, updatedAt: new Date() },
        });
    }
  }
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentAppGrantsTable)
      .where(inArray(agentAppGrantsTable.agentId, createdAgentIds));
    await db
      .delete(tasksTable)
      .where(inArray(tasksTable.agentId, createdAgentIds));
    await db
      .delete(agentsTable)
      .where(inArray(agentsTable.id, createdAgentIds));
  }
  if (createdOwnerRow) {
    await db
      .delete(systemStateTable)
      .where(eq(systemStateTable.key, "owner_clerk_id"));
  }
});

describe("action block parser", () => {
  it("parses explicit blocks and strips them from the prose", () => {
    const { requests, cleaned } = parseAppActions(
      'Check the mailbox.\n<app_action>{"operation":"gmail.search","params":{"query":"from:alice"}}</app_action>\nDone.',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ ok: true, operation: "gmail.search" });
    expect(cleaned).not.toContain("app_action");
    expect(cleaned).toContain("Check the mailbox.");
  });

  it("never treats prose as an action", () => {
    const { requests } = parseAppActions(
      "You should run gmail.search with query from:alice, then send an email.",
    );
    expect(requests).toHaveLength(0);
  });

  it("flags malformed JSON and missing operations as errors, not guesses", () => {
    const { requests } = parseAppActions(
      "<app_action>not json</app_action>\n<app_action>{\"params\":{}}</app_action>",
    );
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => !r.ok)).toBe(true);
  });
});

describe("authorization deny matrix", () => {
  const grants = (
    entries: [ConnectedAppId, AppAccessLevel][],
  ): {
    grants: Map<ConnectedAppId, AppAccessLevel>;
    sensitiveDataSandbox: boolean;
  } => ({
    grants: new Map(entries),
    sensitiveDataSandbox: false,
  });

  it("denies unknown operations", () => {
    const verdict = authorizeAppAction(grants([["gmail", "write"]]), "gmail.delete_everything", {});
    expect(verdict.kind).toBe("deny");
  });

  it("denies apps the agent holds no grant for", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "github.list_repos", {});
    expect(verdict.kind).toBe("deny");
  });

  it("denies operations above the granted level", () => {
    const verdict = authorizeAppAction(
      grants([["gmail", "read"]]),
      "gmail.create_draft",
      { to: "a@b.c", subject: "Hi", body: "Hello" },
    );
    expect(verdict.kind).toBe("deny");
  });

  it("denies invalid params and drops undeclared ones", () => {
    const missing = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {});
    expect(missing.kind).toBe("deny");
    const sneaky = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice",
      rawPath: "/gmail/v1/users/me/settings",
    });
    expect(sneaky.kind).toBe("allow");
    if (sneaky.kind === "allow") {
      expect(Object.keys(sneaky.params)).toEqual(["query"]);
    }
  });

  it("denies header injection via CR/LF in header-bound params", () => {
    const bcc = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c\r\nBcc: everyone@evil.example", subject: "Hi", body: "Hello" },
    );
    expect(bcc.kind).toBe("deny");
    const subj = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi\nX-Injected: yes", body: "Hello" },
    );
    expect(subj.kind).toBe("deny");
    // Multiline bodies remain legitimate.
    const ok = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi", body: "Hello\n\nBest,\nMarlow" },
    );
    expect(ok.kind).toBe("needs_approval");
  });

  it("denies control characters anywhere", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice\x07",
    });
    expect(verdict.kind).toBe("deny");
  });

  it("routes writes to owner approval even at write level", () => {
    const verdict = authorizeAppAction(
      grants([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "Hi", body: "Hello" },
    );
    expect(verdict.kind).toBe("needs_approval");
  });

  it("allows reads within the grant", () => {
    const verdict = authorizeAppAction(grants([["gmail", "read"]]), "gmail.search", {
      query: "from:alice",
    });
    expect(verdict.kind).toBe("allow");
  });
});

describe("prompt section", () => {
  it("is absent without grants and lists only allowed operations", () => {
    expect(buildAppsPromptSection(new Map())).toBeNull();
    const section = buildAppsPromptSection(
      new Map<ConnectedAppId, AppAccessLevel>([["gmail", "read"]]),
    );
    expect(section).toContain("gmail.search");
    expect(section).not.toContain("gmail.create_draft");
    expect(section).not.toContain("github.");
  });
});

describe("connection identity mapping", () => {
  it("maps a missing connection to not_connected with no label", () => {
    expect(describeConnection(undefined)).toEqual({
      status: "not_connected",
      detail: null,
      accountLabel: null,
    });
  });

  it("surfaces a safe account label from metadata and never raw secrets", () => {
    const result = describeConnection({
      connector_name: "google-mail",
      status: "ACTIVE",
      metadata: {
        email: "owner@example.com",
        access_token: "SECRET-TOKEN",
        refresh_token: "SECRET-REFRESH",
      },
    });
    expect(result.status).toBe("connected");
    expect(result.accountLabel).toBe("owner@example.com");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("falls back to a login/username and then to null", () => {
    expect(
      describeConnection({ status: "ACTIVE", metadata: { login: "octocat" } })
        .accountLabel,
    ).toBe("octocat");
    expect(
      describeConnection({
        status: "ACTIVE",
        metadata: { oauth: { credentials: "nope" } },
      }).accountLabel,
    ).toBeNull();
  });

  it("reports an expired/revoked connection as expired, not connected", () => {
    const expired = describeConnection({
      status: "EXPIRED",
      status_message: "Token expired",
      metadata: { email: "owner@example.com" },
    });
    expect(expired.status).toBe("expired");
    expect(expired.detail).toBe("Token expired");
    expect(expired.accountLabel).toBe("owner@example.com");
    expect(
      describeConnection({ status: "ACTIVE", status_message: "authorization revoked" })
        .status,
    ).toBe("expired");
  });

  it("ignores non-string and oversized label candidates", () => {
    expect(
      describeConnection({ status: "ACTIVE", metadata: { email: 42 } }).accountLabel,
    ).toBeNull();
    expect(
      describeConnection({
        status: "ACTIVE",
        metadata: { email: "x".repeat(200) },
      }).accountLabel,
    ).toBeNull();
  });
});

describe("connected-apps routes", () => {
  it("lists all three apps with enable state, identity, and grant counts", async () => {
    const res = await request(app).get("/api/connected-apps");
    expect(res.status).toBe(200);
    const apps = res.body.apps.map((a: { app: string }) => a.app);
    expect(apps).toEqual(["gmail", "google_drive", "github"]);
    for (const entry of res.body.apps) {
      expect(typeof entry.enabled).toBe("boolean");
      expect(typeof entry.grantedAgents).toBe("number");
      expect(["connected", "expired", "not_connected", "unavailable"]).toContain(
        entry.status,
      );
      // Identity is always present and safe: a string label or an explicit null.
      expect("accountLabel" in entry).toBe(true);
      expect(
        entry.accountLabel === null || typeof entry.accountLabel === "string",
      ).toBe(true);
    }
  });

  it("rejects unknown apps and bad bodies", async () => {
    const bad = await request(app)
      .patch("/api/connected-apps/slack")
      .send({ enabled: false });
    expect(bad.status).toBe(400);
    const badBody = await request(app)
      .patch("/api/connected-apps/gmail")
      .send({ enabled: "nope" });
    expect(badBody.status).toBe(400);
  });

  it("toggles the workspace-wide switch and reports it", async () => {
    await rememberSetting("google_drive");
    const off = await request(app)
      .patch("/api/connected-apps/google_drive")
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    const list = await request(app).get("/api/connected-apps");
    const drive = list.body.apps.find((a: { app: string }) => a.app === "google_drive");
    expect(drive.enabled).toBe(false);
    const on = await request(app)
      .patch("/api/connected-apps/google_drive")
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
  });
});

describe("agent grant lifecycle", () => {
  it("creates an agent with grants and returns them everywhere", async () => {
    const res = await createAgent("Grantee", {
      appGrants: [
        { app: "gmail", accessLevel: "draft" },
        { app: "github", accessLevel: "read" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.appGrants).toEqual(
      expect.arrayContaining([
        { app: "gmail", accessLevel: "draft" },
        { app: "github", accessLevel: "read" },
      ]),
    );

    const detail = await request(app).get(`/api/agents/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.agent.appGrants).toHaveLength(2);

    const list = await request(app).get("/api/agents");
    const mine = list.body.find((a: { id: string }) => a.id === res.body.id);
    expect(mine.appGrants).toHaveLength(2);
  });

  it("deduplicates conflicting grants for the same app, keeping the last", async () => {
    const res = await createAgent("Dedupe", {
      appGrants: [
        { app: "gmail", accessLevel: "read" },
        { app: "gmail", accessLevel: "write" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.appGrants).toEqual([{ app: "gmail", accessLevel: "write" }]);
  });

  it("replaces the grant set on update and leaves it alone when omitted", async () => {
    const created = await createAgent("Replacer", {
      appGrants: [{ app: "gmail", accessLevel: "read" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Update without appGrants: grants unchanged.
    const rename = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ title: "Renamed Analyst" });
    expect(rename.status).toBe(200);
    expect(rename.body.appGrants).toEqual([{ app: "gmail", accessLevel: "read" }]);

    // Update with a new set: full replacement.
    const swap = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ appGrants: [{ app: "google_drive", accessLevel: "draft" }] });
    expect(swap.status).toBe(200);
    expect(swap.body.appGrants).toEqual([
      { app: "google_drive", accessLevel: "draft" },
    ]);

    // Empty set revokes everything.
    const revoke = await request(app)
      .patch(`/api/agents/${id}`)
      .send({ appGrants: [] });
    expect(revoke.status).toBe(200);
    expect(revoke.body.appGrants).toEqual([]);
  });

  it("caps a sandboxed agent at read regardless of the stored grant level", () => {
    const sandboxed = (
      entries: [ConnectedAppId, AppAccessLevel][],
    ) => ({ grants: new Map(entries), sensitiveDataSandbox: true });

    // Reads still work — that is the whole point of the sandbox.
    const read = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.search",
      { query: "from:alice" },
    );
    expect(read.kind).toBe("allow");

    // Drafts are denied even though the grant says write.
    const draft = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.create_draft",
      { to: "a@b.c", subject: "s", body: "b" },
    );
    expect(draft.kind).toBe("deny");
    if (draft.kind === "deny") {
      expect(draft.reason).toMatch(/sensitive data sandbox/i);
    }

    // Writes never even reach the approval queue.
    const write = authorizeAppAction(
      sandboxed([["gmail", "write"]]),
      "gmail.send_email",
      { to: "a@b.c", subject: "s", body: "b" },
    );
    expect(write.kind).toBe("deny");
  });

  it("shows a sandboxed agent only read operations, framed as read-only", () => {
    const grants = new Map<"gmail" | "google_drive" | "github", "read" | "draft" | "write">([
      ["gmail", "write"],
      ["github", "write"],
    ]);
    const prompt = buildAppsPromptSection(grants, { sensitiveDataSandbox: true });
    expect(prompt).toBeTruthy();
    expect(prompt!).toMatch(/sensitive data sandbox/i);
    expect(prompt!).toContain("gmail.search");
    expect(prompt!).not.toContain("gmail.send_email");
    expect(prompt!).not.toContain("gmail.create_draft");
    // Untrusted-data framing is present for everyone.
    expect(prompt!).toMatch(/UNTRUSTED EXTERNAL DATA/);
    // A sandboxed agent with only write-level operations available at its
    // grant sees a read list, never an empty write list.
    const unsandboxed = buildAppsPromptSection(grants);
    expect(unsandboxed!).toContain("gmail.send_email");
  });

  it("never copies grants when duplicating an agent", async () => {
    const created = await createAgent("Original", {
      appGrants: [{ app: "github", accessLevel: "write" }],
    });
    expect(created.status).toBe(201);
    const dup = await request(app).post(
      `/api/agents/${created.body.id}/duplicate`,
    );
    expect(dup.status).toBe(201);
    createdAgentIds.push(dup.body.id);
    expect(dup.body.appGrants).toEqual([]);
    const detail = await request(app).get(`/api/agents/${dup.body.id}`);
    expect(detail.body.agent.appGrants).toEqual([]);
  });
});

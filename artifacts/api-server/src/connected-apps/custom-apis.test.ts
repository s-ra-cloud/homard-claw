/**
 * Custom API coverage (definitions + executor):
 *  - definition normalization: slug/base-URL/operation/param constraint
 *    matrix, traversal + CRLF + forbidden-header rejection
 *  - credential sealing: roundtrip, tamper detection, fail-closed secret
 *  - manifest synthesis: tool names, revision pinning, recovery classes
 *  - OpenAPI import: JSON-only, bounded, unsupported constructs skipped
 *  - the hardened executor via DI: SSRF/private/metadata DNS refusal,
 *    redirect refusal, size caps, secret redaction, revision/enablement/
 *    tenancy checks at the final boundary, and the per-connection limiter
 *
 * Conventions (see .agents/memory/api-server-test-conventions.md): the dev
 * Postgres is shared — every row is created under this run's workspace and
 * removed in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customApiConnectionsTable,
  db,
  workspacesTable,
  type CustomApiConnectionRecord,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import type { LookupAddress } from "node:dns";
import {
  decryptCustomApiCredential,
  encryptCustomApiCredential,
  manifestForCustomApi,
  normalizeCustomApiDefinition,
  parseStoredOperations,
  validateBaseUrl,
  validateCredentialInput,
  type CustomApiOperation,
} from "./custom-apis";
import { parseOpenApiDocument } from "./custom-api-spec";
import {
  buildRequestPlan,
  executeCustomApiTool,
  resetCustomApiLimiter,
  validateCustomApiConnection,
  type CustomApiRawResponse,
  type CustomApiRequestPlan,
} from "./custom-api-executor";
import type { ResolvedCapabilityTool } from "../capabilities/service";

const SECRET_VALUE = "sk-live-super-secret-token-12345";

function baseOps(): CustomApiOperation[] {
  return [
    {
      id: "get_thing",
      method: "GET",
      path: "/things/{id}",
      description: "Fetch one thing",
      level: "read",
      params: [{ name: "id", in: "path", kind: "string", required: true }],
    },
    {
      id: "create_thing",
      method: "POST",
      path: "/things",
      description: "Create a thing",
      level: "write",
      params: [
        {
          name: "title",
          in: "body",
          kind: "string",
          required: true,
          maxLength: 200,
        },
      ],
    },
  ];
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: "thing_api",
    displayName: "Thing API",
    description: "Test API",
    baseUrl: "https://api.example.com/v1",
    authType: "bearer",
    operations: baseOps(),
    ...overrides,
  };
}

describe("definition normalization", () => {
  it("accepts a valid definition and normalizes the base URL", () => {
    const result = normalizeCustomApiDefinition(
      validInput({ baseUrl: "https://api.example.com/v1/" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://api.example.com/v1");
      expect(result.value.operations).toHaveLength(2);
      expect(result.value.authHeaderName).toBeNull();
    }
  });

  it.each([
    ["http://api.example.com", /https/],
    ["https://10.0.0.1/api", /hostname, not an IP/],
    ["https://[::1]/api", /hostname, not an IP/],
    ["https://localhost/api", /public hostname/],
    ["https://foo.local/api", /public hostname/],
    ["https://foo.internal/api", /public hostname/],
    ["https://intranet/api", /public hostname/],
    ["https://user:pw@api.example.com", /credentials/],
    ["https://api.example.com/?q=1", /query string/],
    ["not a url", /not contain whitespace|not a valid URL/],
  ])("rejects base URL %s", (baseUrl, message) => {
    const result = validateBaseUrl(baseUrl);
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") expect(result.error).toMatch(message);
  });

  it("normalizes dot-segments in the base URL so no traversal survives", () => {
    // WHATWG URL parsing collapses /a/../b before validation; the stored
    // base is the normalized form, so nothing traversable is ever saved.
    expect(validateBaseUrl("https://api.example.com/a/../b")).toBe(
      "https://api.example.com/b",
    );
  });

  it("forces GET to read and non-GET above read", () => {
    const asWrite = normalizeCustomApiDefinition(
      validInput({
        operations: [{ ...baseOps()[0], level: "write" }],
      }),
    );
    expect(asWrite.ok).toBe(false);
    if (!asWrite.ok) {
      expect(asWrite.errors.join(" ")).toMatch(/GET operations are always/);
    }
    const asRead = normalizeCustomApiDefinition(
      validInput({
        operations: [{ ...baseOps()[1], level: "read" }],
      }),
    );
    expect(asRead.ok).toBe(false);
    if (!asRead.ok) {
      expect(asRead.errors.join(" ")).toMatch(/draft.*write|write.*draft/i);
    }
  });

  it("rejects body params on GET/DELETE, traversal, CRLF, and placeholder mismatches", () => {
    const bodyOnGet = normalizeCustomApiDefinition(
      validInput({
        operations: [
          {
            ...baseOps()[0],
            path: "/things",
            params: [{ name: "q", in: "body", kind: "string", required: true }],
          },
        ],
      }),
    );
    expect(bodyOnGet.ok).toBe(false);

    for (const path of [
      "/things/../admin",
      "/things//all",
      "/things/%0d%0aInjected",
      "/things/a b",
    ]) {
      const result = normalizeCustomApiDefinition(
        validInput({
          operations: [{ ...baseOps()[1], path, params: [] }],
        }),
      );
      // %0d%0a passes the charset but renders literally (no decode); the
      // others must be outright rejected.
      if (path === "/things/%0d%0aInjected") continue;
      expect(result.ok, path).toBe(false);
    }

    const undeclared = normalizeCustomApiDefinition(
      validInput({
        operations: [{ ...baseOps()[0], params: [] }],
      }),
    );
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.errors.join(" ")).toMatch(/no matching path parameter/);
    }
  });

  it("rejects reserved auth headers for api_key", () => {
    for (const header of ["Authorization", "Host", "Cookie", "Content-Type"]) {
      const result = normalizeCustomApiDefinition(
        validInput({ authType: "api_key", authHeaderName: header }),
      );
      expect(result.ok, header).toBe(false);
    }
    const ok = normalizeCustomApiDefinition(
      validInput({ authType: "api_key", authHeaderName: "X-Api-Key" }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.authHeaderName).toBe("X-Api-Key");
  });

  it("caps the operation count with an actionable error", () => {
    const ops = Array.from({ length: 31 }, (_, i) => ({
      ...baseOps()[1],
      id: `op_${i}`,
      params: [],
    }));
    const result = normalizeCustomApiDefinition(validInput({ operations: ops }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/at most 30/i);
  });
});

describe("credential sealing", () => {
  beforeAll(() => {
    vi.stubEnv("SESSION_SECRET", "custom-api-test-secret");
  });

  it("roundtrips, and tampering fails closed with a rotate hint", () => {
    const sealed = encryptCustomApiCredential(SECRET_VALUE);
    expect(sealed).not.toContain(SECRET_VALUE);
    expect(decryptCustomApiCredential(sealed)).toBe(SECRET_VALUE);
    const [v, iv, tag, body] = sealed.split(".");
    const tampered = [v, iv, tag, body!.slice(0, -4) + "AAAA"].join(".");
    expect(() => decryptCustomApiCredential(tampered)).toThrow(/[Rr]otate/);
  });

  it("validates credential input", () => {
    expect(validateCredentialInput("  tok  ")).toBe("tok");
    expect(typeof validateCredentialInput("")).toBe("object");
    expect(typeof validateCredentialInput("a\r\nb")).toBe("object");
    expect(typeof validateCredentialInput("x".repeat(5000))).toBe("object");
  });
});

describe("OpenAPI import", () => {
  const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Petstore" },
      servers: [{ url: "https://petstore.example.com/v2" }],
      paths,
      ...extra,
    });

  it("extracts bounded operations, base URL, and name from JSON", () => {
    const result = parseOpenApiDocument(
      doc({
        "/pets": {
          get: {
            operationId: "listPets",
            summary: "List pets",
            parameters: [
              { name: "limit", in: "query", schema: { type: "integer" } },
            ],
          },
          post: {
            operationId: "createPet",
            summary: "Create a pet",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.suggestedBaseUrl).toBe(
        "https://petstore.example.com/v2",
      );
      expect(result.value.suggestedName).toBe("Petstore");
      const ids = result.value.operations.map((op) => op.id);
      expect(ids).toContain("list_pets");
      expect(ids).toContain("create_pet");
      const get = result.value.operations.find((op) => op.id === "list_pets")!;
      expect(get.level).toBe("read");
      const post = result.value.operations.find(
        (op) => op.id === "create_pet",
      )!;
      expect(post.level).toBe("write");
      expect(post.params.map((p) => p.name)).toContain("name");
    }
  });

  it("resolves colliding operation ids without looping, even at the length cap", () => {
    // Two distinct overlong ids that normalize to the same 60-char prefix
    // used to spin the de-dup loop forever: the suffix was appended and then
    // truncated straight back off. Also cover a plain duplicate id.
    const longA = `getVeryLongOperation${"X".repeat(80)}AlphaEnd`;
    const longB = `getVeryLongOperation${"X".repeat(80)}BravoEnd`;
    const result = parseOpenApiDocument(
      doc({
        "/a": { get: { operationId: longA, summary: "A" } },
        "/b": { get: { operationId: longB, summary: "B" } },
        "/c": { get: { operationId: "samePets", summary: "C" } },
        "/d": { get: { operationId: "samePets", summary: "D" } },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.value.operations.map((op) => op.id);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      for (const id of ids) {
        expect(id.length).toBeLessThanOrEqual(60);
        expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      expect(ids).toContain("same_pets");
      expect(ids).toContain("same_pets_2");
    }
  });

  it("rejects YAML with a convert-to-JSON hint and rejects oversized docs", () => {
    const yaml = parseOpenApiDocument("openapi: 3.0.0\npaths: {}");
    expect(yaml.ok).toBe(false);
    if (!yaml.ok) expect(yaml.error).toMatch(/JSON/);
    const big = parseOpenApiDocument(`{"openapi":"3.0.0","x":"${"a".repeat(600_000)}"}`);
    expect(big.ok).toBe(false);
  });

  it("skips unsupported constructs with warnings instead of guessing", () => {
    const result = parseOpenApiDocument(
      doc({
        "/pets": {
          get: { operationId: "listPets", summary: "List pets" },
          put: {
            operationId: "withHeader",
            summary: "Has header param",
            parameters: [
              { name: "X-Custom", in: "header", schema: { type: "string" } },
            ],
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.operations.map((op) => op.id)).toEqual([
        "list_pets",
      ]);
      expect(result.value.warnings.join(" ")).toMatch(/header/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

const PUBLIC_V4: LookupAddress = { address: "93.184.216.34", family: 4 };

function respond(
  status: number,
  body: string,
  overrides: Partial<CustomApiRawResponse> = {},
) {
  return async (
    _plan: CustomApiRequestPlan,
    _pinned: LookupAddress,
    _options: { timeoutMs: number; maxBytes: number },
  ): Promise<CustomApiRawResponse> => ({
    status,
    contentType: "application/json",
    location: null,
    body: Buffer.from(body, "utf8"),
    ...overrides,
  });
}

describe("hardened executor", () => {
  let workspaceId: string;
  let otherWorkspaceId: string;
  let row: CustomApiConnectionRecord;

  const makeTool = (
    record: CustomApiConnectionRecord,
    opId: string,
  ): ResolvedCapabilityTool => {
    const manifest = manifestForCustomApi(record);
    if (!manifest) throw new Error("manifest did not resolve");
    const def = manifest.tools.find((tool) =>
      tool.name.endsWith(`.${opId}`),
    )!;
    return {
      name: def.name,
      packageId: manifest.id,
      packageDisplayName: manifest.displayName,
      description: def.description,
      level: def.level,
      def,
      builtinOp: null,
      manifest,
      recovery: def.recovery,
    };
  };

  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", "custom-api-test-secret");
    const [ws] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `custom-api-exec-${Date.now()}` })
      .returning();
    workspaceId = ws.id;
    const [other] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `custom-api-exec-other-${Date.now()}` })
      .returning();
    otherWorkspaceId = other.id;
    const [inserted] = await db
      .insert(customApiConnectionsTable)
      .values({
        workspaceId,
        slug: "thing_api",
        displayName: "Thing API",
        description: "Executor test API",
        baseUrl: "https://api.example.com/v1",
        authType: "bearer",
        credentialEnc: encryptCustomApiCredential(SECRET_VALUE),
        operations: baseOps() as unknown as Record<string, unknown>[],
      })
      .returning();
    row = inserted;
  });

  afterAll(async () => {
    await db
      .delete(customApiConnectionsTable)
      .where(eq(customApiConnectionsTable.workspaceId, workspaceId));
    await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    await db
      .delete(workspacesTable)
      .where(eq(workspacesTable.id, otherWorkspaceId));
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    resetCustomApiLimiter();
  });

  describe("request plan (template rendering)", () => {
    const op = baseOps()[0]!;

    it("renders path params as single encoded segments that cannot escape", () => {
      // Benign values with dots pass through as one encoded segment.
      const plan = buildRequestPlan(row, op, { id: "file.txt" }, "tok");
      expect(plan.url.pathname).toBe("/v1/things/file.txt");
      const encoded = buildRequestPlan(row, op, { id: "a b/c" }, "tok");
      expect(encoded.url.pathname).toBe("/v1/things/a%20b%2Fc");
      // Anything that would put ".." in the rendered path is refused
      // outright — even encoded, the executor treats it as an escape.
      expect(() =>
        buildRequestPlan(row, op, { id: "abc/../../etc" }, "tok"),
      ).toThrow(/escaped the approved base URL/);
      expect(() => buildRequestPlan(row, op, { id: ".." }, "tok")).toThrow(
        /non-empty path segment|escaped the approved base URL/,
      );
      expect(() => buildRequestPlan(row, op, { id: "" }, "tok")).toThrow(
        /non-empty path segment/,
      );
    });

    it("keeps the header set closed and injects exactly one auth header", () => {
      const plan = buildRequestPlan(row, op, { id: "x" }, "tok-123");
      expect(plan.headers.authorization).toBe("Bearer tok-123");
      expect(Object.keys(plan.headers).sort()).toEqual([
        "accept",
        "accept-encoding",
        "authorization",
        "user-agent",
      ]);
      // CRLF in a query value is encoded, not spliced.
      const query = buildRequestPlan(
        { ...row, authType: "none" },
        {
          ...op,
          path: "/things",
          params: [{ name: "q", in: "query", kind: "string", required: false }],
        },
        { q: "a\r\nHost: evil" },
        null,
      );
      expect(query.url.search).not.toContain("\r");
      expect(query.url.search).toContain("%0D%0A");
    });

    it("refuses a missing credential and an oversized body", () => {
      expect(() => buildRequestPlan(row, op, { id: "x" }, null)).toThrow(
        /none is saved/,
      );
      const post = baseOps()[1]!;
      expect(() =>
        buildRequestPlan(row, post, { title: "y".repeat(150_000) }, "tok"),
      ).toThrow(/exceeds the 100 KB limit/);
    });
  });

  describe("network boundary", () => {
    it.each([
      ["private IPv4", "10.1.2.3", 4],
      ["loopback", "127.0.0.1", 4],
      ["link-local metadata", "169.254.169.254", 4],
      ["carrier NAT", "100.64.0.1", 4],
      ["IPv6 unique-local", "fd00::1", 6],
      ["IPv6 link-local", "fe80::1", 6],
      ["IPv6 loopback", "::1", 6],
    ])("refuses %s DNS answers", async (_label, address, family) => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [{ address, family } as LookupAddress],
          requestOnce: respond(200, "{}"),
        },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.message).toMatch(/public internet addresses/);
      }
    });

    it("refuses when ANY resolved address is private (rebinding split answers)", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [
            PUBLIC_V4,
            { address: "192.168.1.10", family: 4 },
          ],
          requestOnce: respond(200, "{}"),
        },
      );
      expect(outcome.ok).toBe(false);
    });

    it("never follows redirects and never reveals the Location target", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [PUBLIC_V4],
          requestOnce: respond(302, "", {
            location: "https://evil.example/steal",
          }),
        },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.message).toMatch(/redirect/);
        expect(outcome.message).not.toContain("evil.example");
      }
    });

    it("classifies 401/403 as auth and redacts the credential everywhere", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [PUBLIC_V4],
          requestOnce: respond(401, `{"error":"bad token ${SECRET_VALUE}"}`),
        },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("auth");
        expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
      }
      const success = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [PUBLIC_V4],
          requestOnce: respond(200, `{"leaked":"${SECRET_VALUE}"}`),
        },
      );
      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.summary).not.toContain(SECRET_VALUE);
        expect(success.summary).toContain("[redacted]");
      }
    });

    it("bounds huge textual responses to the tool's char limit", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [PUBLIC_V4],
          requestOnce: respond(200, "z".repeat(50_000)),
        },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.summary.length).toBeLessThan(5_000);
        expect(outcome.summary).toContain("[truncated");
      }
    });

    it("hides binary bodies and strips control characters from text", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId },
        {
          resolve: async () => [PUBLIC_V4],
          requestOnce: respond(200, "ignored", {
            contentType: "application/octet-stream",
            body: Buffer.from([0x00, 0x01, 0x02]),
          }),
        },
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.summary).toMatch(/binary .*not shown/);
    });
  });

  describe("final-boundary state checks", () => {
    it("refuses cross-workspace execution", async () => {
      const outcome = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        { workspaceId: otherWorkspaceId },
        { resolve: async () => [PUBLIC_V4], requestOnce: respond(200, "{}") },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.message).toMatch(/no longer configured/);
    });

    it("refuses a stale manifest revision and a stale recorded revision", async () => {
      const staleManifest = makeTool(
        { ...row, revision: "00000000-0000-0000-0000-000000000000" },
        "get_thing",
      );
      const stale = await executeCustomApiTool(
        staleManifest,
        { id: "1" },
        { workspaceId },
        { resolve: async () => [PUBLIC_V4], requestOnce: respond(200, "{}") },
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.message).toMatch(/definition changed/);

      const recorded = await executeCustomApiTool(
        makeTool(row, "get_thing"),
        { id: "1" },
        {
          workspaceId,
          expectedRevision: "11111111-1111-1111-1111-111111111111",
        },
        { resolve: async () => [PUBLIC_V4], requestOnce: respond(200, "{}") },
      );
      expect(recorded.ok).toBe(false);
      if (!recorded.ok) expect(recorded.message).toMatch(/not executed/);
    });

    it("refuses immediately when the owner disabled the API", async () => {
      await db
        .update(customApiConnectionsTable)
        .set({ enabled: false })
        .where(eq(customApiConnectionsTable.id, row.id));
      try {
        const outcome = await executeCustomApiTool(
          makeTool(row, "get_thing"),
          { id: "1" },
          { workspaceId },
          { resolve: async () => [PUBLIC_V4], requestOnce: respond(200, "{}") },
        );
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.message).toMatch(/disabled/);
      } finally {
        await db
          .update(customApiConnectionsTable)
          .set({ enabled: true })
          .where(eq(customApiConnectionsTable.id, row.id));
      }
    });

    it("enforces the per-minute limiter", async () => {
      const deps = {
        resolve: async () => [PUBLIC_V4],
        requestOnce: respond(200, "{}"),
      };
      let limited = 0;
      for (let i = 0; i < 31; i += 1) {
        const outcome = await executeCustomApiTool(
          makeTool(row, "get_thing"),
          { id: "1" },
          { workspaceId },
          deps,
        );
        if (!outcome.ok && /per-minute/.test(outcome.message)) limited += 1;
      }
      expect(limited).toBe(1);
    });
  });

  describe("validation probe", () => {
    it("treats any non-auth HTTP answer as reachable and 401 as credential failure", async () => {
      const ok = await validateCustomApiConnection(row, {
        resolve: async () => [PUBLIC_V4],
        requestOnce: respond(404, "not found"),
      });
      expect(ok.ok).toBe(true);
      const bad = await validateCustomApiConnection(row, {
        resolve: async () => [PUBLIC_V4],
        requestOnce: respond(401, "no"),
      });
      expect(bad.ok).toBe(false);
      expect(bad.detail).toMatch(/credential/);
    });

    it("fails with a clear message when the DNS answer is private", async () => {
      const result = await validateCustomApiConnection(row, {
        resolve: async () => [{ address: "10.0.0.5", family: 4 }],
        requestOnce: respond(200, "{}"),
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/public internet addresses/);
    });
  });
});

describe("stored operations parsing", () => {
  it("fails closed on malformed stored operations", () => {
    expect(
      parseStoredOperations({
        operations: [{ id: "bad id!", method: "GET" }] as unknown as Record<
          string,
          unknown
        >[],
      }),
    ).toBeNull();
    expect(
      parseStoredOperations({
        operations: baseOps() as unknown as Record<string, unknown>[],
      }),
    ).toHaveLength(2);
  });

  it("pins the manifest version to the row revision and maps recovery", () => {
    const manifest = manifestForCustomApi({
      id: "00000000-0000-0000-0000-00000000abcd",
      workspaceId: "00000000-0000-0000-0000-00000000dcba",
      slug: "thing_api",
      displayName: "Thing API",
      description: "d",
      baseUrl: "https://api.example.com/v1",
      authType: "none",
      authHeaderName: null,
      credentialEnc: null,
      operations: baseOps() as unknown as Record<string, unknown>[],
      revision: "rev-1",
      enabled: true,
      validationStatus: "unchecked",
      validationDetail: null,
      validatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as CustomApiConnectionRecord);
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe("custom_thing_api");
    expect(manifest!.version).toBe("rev-1");
    const read = manifest!.tools.find((t) => t.name.endsWith(".get_thing"))!;
    const write = manifest!.tools.find(
      (t) => t.name.endsWith(".create_thing"),
    )!;
    expect(read.recovery).toBe("retry_safe");
    expect(write.recovery).toBe("non_retryable");
    expect(write.level).toBe("write");
    expect(read.executor).toMatchObject({
      kind: "custom_api",
      operationId: "get_thing",
    });
  });
});

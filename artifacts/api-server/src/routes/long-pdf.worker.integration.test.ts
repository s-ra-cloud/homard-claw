/**
 * Full-worker long-PDF regression.
 *
 * This is intentionally an integration test rather than a transport test:
 * Drive HTTP is mocked, but the native Drive action, the production isolated
 * PDF extractor, the worker's provider adapter and the database action ledger
 * all remain in the path.  The fixture is generated locally so no document
 * content or provider credential leaves the test process.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsTable,
  appActionsTable,
  db,
  googleAccountsTable,
  pool,
  taskLogsTable,
  tasksTable,
  workspaceConnectedAppsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const authState = vi.hoisted(() => ({
  userId: null as string | null,
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
  clerkClient: {
    users: {
      getUser: async () => {
        throw new Error("no such user");
      },
    },
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

const executeMock = vi.hoisted(() => vi.fn());
const actualExecuteOperation = vi.hoisted(() => ({
  current: null as null | ((
    operation: unknown,
    params: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<unknown>),
}));

vi.mock("../connected-apps/connections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connected-apps/connections")>();
  actualExecuteOperation.current = actual.executeOperation as unknown as NonNullable<
    typeof actualExecuteOperation.current
  >;
  return { ...actual, executeOperation: executeMock };
});

import officeRouter from "./office";
import { claimNextTask, runTask } from "../worker";
import { clearGoogleTokenCache, encryptRefreshToken } from "../google/credentials";
import { clearProviderCaches } from "../providers";
import { saveProviderCredential } from "../provider-credentials";
import type { PdfSummaryEvidence } from "../connected-apps/connections";
import {
  LongPdfSummaryError,
  runLongPdfSummary,
  type LongPdfSummaryCheckpoint,
  type LongPdfSummaryEvidence,
} from "../long-pdf-summary";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC long PDF ${Date.now()}`;
const createdAgentIds: string[] = [];
let workspaceId: string;

const PRICING_CATALOG = {
  data: [
    {
      id: "test-vendor/test-model",
      name: "Long PDF test model",
      context_length: 32_768,
      pricing: { prompt: "0.000001", completion: "0.00001" },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 2_000, completion_tokens: 160 },
  };
}

function pdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/**
 * Build a real PDF, not a parser-shaped text blob. Every line is positioned
 * inside the media box. Keeping each page's marker in several short lines
 * prevents PDF.js from dropping a long off-page glyph run.
 */
export function densePdfFixture(totalPages = 600): Uint8Array {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) {
    throw new Error("totalPages must be a positive integer");
  }
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from(
      { length: totalPages },
      (_, index) => `${4 + index * 2} 0 R`,
    ).join(" ")}] /Count ${totalPages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 1; page <= totalPages; page += 1) {
    const marker = `PAGE-MARKER-${String(page).padStart(3, "0")}`;
    const lines = [
      `${marker} source evidence begins on page ${page}.`,
      `${marker} Every page is independently addressable by the long summary job.`,
      ...Array.from(
        { length: 30 },
        (_, line) =>
          `${marker} Dense evidence line ${String(line + 1).padStart(2, "0")}: ` +
          `${"abcdefghijklmnopqrstuv".repeat(4)} ${"0123456789".repeat(8)}.`,
      ),
      // Keep a marker on the final extracted line as well as the first line;
      // this catches parsers that accidentally drop the tail of each page.
      `${marker} PAGE-MARKER-${String(page).padStart(3, "0")} tail evidence is in bounds.`,
    ];
    const stream = [
      "BT /F1 5 Tf 36 756 Td",
      ...lines.map((line, index) =>
        `${index === 0 ? "" : "0 -10 Td "}(${pdfString(line)}) Tj`,
      ),
      "ET",
    ].join(" ");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + indexOfPage(page)} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }

  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

// Page objects begin at object 4 and alternate with their content stream.
function indexOfPage(page: number): number {
  return (page - 1) * 2;
}

async function createAgent() {
  const response = await request(app).post("/api/agents").send({
    name: `Long PDF ${RUN_TAG} ${createdAgentIds.length + 1}`,
    title: "Long PDF integration tester",
    mission: "Summarize every page of a dense test PDF.",
    provider: "openrouter",
    securityPreset: "assistant",
    autonomy: "autonomous",
    permissionOverrides: {
      maxTaskBudgetCents: null,
      dailyBudgetCents: null,
      maxTasksPerDay: null,
    },
    avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    appGrants: [{ app: "google_drive", accessLevel: "read" }],
  });
  expect(response.status).toBe(201);
  createdAgentIds.push(response.body.id);
  const paused = await request(app)
    .post(`/api/agents/${response.body.id}/pause`)
    .send({ paused: true });
  expect(paused.status).toBe(200);
  return response.body as { id: string };
}

async function loadAgent(agentId: string) {
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  return agent!;
}

async function insertRunningTask(agentId: string) {
  const [task] = await db
    .insert(tasksTable)
    .values({
      agentId,
      workspaceId,
      objective: `${RUN_TAG}: traverse long-pdf-600 and summarize all source evidence`,
      provider: "openrouter",
      model: "test-vendor/test-model",
      status: "running",
      attempts: 1,
      startedAt: new Date(),
      estimatedCostCents: 1,
    })
    .returning();
  return task!;
}

async function getTask(taskId: string) {
  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return task;
}

function userPrompt(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })
    .messages;
  return (messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

function actionBlock(params: Record<string, unknown>): string {
  return `<app_action>${JSON.stringify({
    operation: "google_drive.read_pdf_summary_batch",
    params,
  })}</app_action>`;
}

describe("full worker flow for a dense 600-page PDF", () => {
  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", "long-pdf-worker-test-secret");
    const [workspace] = await db
      .insert(workspacesTable)
      .values({ clerkUserId: `long-pdf-worker-${Date.now()}` })
      .returning();
    workspaceId = workspace.id;
    authState.userId = workspace.clerkUserId;
    await db.insert(googleAccountsTable).values({
      workspaceId,
      clerkUserId: workspace.clerkUserId,
      googleSub: `google-${RUN_TAG}`,
      email: "long-pdf-worker@example.test",
      refreshTokenEnc: encryptRefreshToken("long-pdf-test-refresh-token"),
      scopes:
        "openid email https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive",
    });
    const enabled = await request(app)
      .patch("/api/connected-apps/google_drive")
      .send({ enabled: true });
    expect(enabled.status).toBe(200);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    executeMock.mockReset();
    executeMock.mockImplementation((operation: unknown, params, context) =>
      actualExecuteOperation.current!(operation, params, context),
    );
    await saveProviderCredential(workspaceId, "openrouter", "long-pdf-test-key");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "long-pdf-client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "long-pdf-client-secret");
    clearGoogleTokenCache();
    clearProviderCaches();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (createdAgentIds.length > 0) {
      await db
        .delete(appActionsTable)
        .where(inArray(appActionsTable.agentId, createdAgentIds));
      await db
        .delete(tasksTable)
        .where(inArray(tasksTable.agentId, createdAgentIds));
      await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
    }
    await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    await pool.end();
  });

  it(
    "reaches page 600 through native Drive extraction with bounded serial synthesis",
    async () => {
      const agent = await createAgent();
      const task = await insertRunningTask(agent.id);
      const fixture = densePdfFixture();
      const providerBodies: unknown[] = [];
      const sectionBodies: string[] = [];
      const pdfEvidence: PdfSummaryEvidence[] = [];
      let initialActionCalls = 0;
      let startedAction = false;

      executeMock.mockImplementation(
        async (
          operation: unknown,
          params: Record<string, unknown>,
          context: Record<string, unknown>,
        ) => {
          const outcome = await actualExecuteOperation.current!(
            operation,
            params,
            context,
          );
          if (
            (operation as { name?: string }).name ===
              "google_drive.read_pdf_summary_batch" &&
            outcome &&
            typeof outcome === "object" &&
            "ok" in outcome &&
            outcome.ok === true &&
            "pdfSummary" in outcome &&
            outcome.pdfSummary
          ) {
            pdfEvidence.push(outcome.pdfSummary as PdfSummaryEvidence);
          }
          return outcome;
        },
      );

      fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const target = String(url);
        if (target.includes("/models")) return jsonResponse(PRICING_CATALOG);
        if (target.includes("oauth2.googleapis.com/token")) {
          return jsonResponse({ access_token: "long-pdf-drive-access", expires_in: 3600 });
        }
        if (target.includes("alt=media")) {
          return new Response(fixture, {
            headers: { "content-type": "application/pdf" },
          });
        }
        if (target.includes("/drive/v3/files/long-pdf-600")) {
          return jsonResponse({
            id: "long-pdf-600",
            name: "dense-600-pages.pdf",
            mimeType: "application/pdf",
            modifiedTime: "2026-01-01T00:00:00.000Z",
            size: String(fixture.byteLength),
          });
        }
        if (target.includes("chat/completions")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
          providerBodies.push(body);
          const prompt = userPrompt(body);
          if (
            /PAGE-MARKER-/.test(prompt) &&
            /\b(section|synthesis|reduce|material)\b/i.test(prompt)
          ) {
            sectionBodies.push(prompt);
            return jsonResponse(
              completion(
                "Section synthesis preserved every source marker in this bounded section.",
              ),
            );
          }
          if (!startedAction) {
            startedAction = true;
            initialActionCalls += 1;
            return jsonResponse(
              completion(actionBlock({ fileId: "long-pdf-600", startPage: 1 })),
            );
          }
          return jsonResponse(
            completion(
              "All 600 pages were traversed and every bounded source section was synthesized.",
            ),
          );
        }
        throw new Error(`unexpected long-PDF request: ${target}`);
      });

      await runTask({ task, agent: await loadAgent(agent.id) });

      const done = await getTask(task.id);
      expect(done?.status).toBe("completed");
      expect(done?.errorKind).toBeNull();
      expect(done?.actualInputTokens ?? 0).toBeGreaterThan(0);
      expect(done?.actualOutputTokens ?? 0).toBeGreaterThan(0);
      expect(initialActionCalls).toBe(1);
      expect(providerBodies.length).toBeLessThan(120);
      expect(Math.max(...providerBodies.map((body) => JSON.stringify(body).length)))
        .toBeLessThan(120_000);

      const actions = await db
        .select()
        .from(appActionsTable)
        .where(eq(appActionsTable.taskId, task.id));
      const pdfActions = actions.filter(
        (action) => action.operation === "google_drive.read_pdf_summary_batch",
      );
      expect(pdfActions.length).toBeGreaterThan(0);
      expect(pdfActions.every((action) => action.status === "executed")).toBe(true);
      expect(actions.some((action) => action.operation === "google_drive.read_file"))
        .toBe(false);
      expect(pdfEvidence.length).toBeGreaterThan(0);
      expect(pdfEvidence.some((evidence) => evidence.continuation)).toBe(true);

      // The native typed evidence, not a signed-cursor string or result prose,
      // proves exact scalar contiguity and real continuation pressure. Every
      // 25-page batch must require at least two continuation calls.
      for (let startPage = 1; startPage <= 600; startPage += 25) {
        const batch = pdfEvidence.filter(
          (evidence) => evidence.coverage.startPage === startPage,
        );
        let scalarOffset = 0;
        for (const evidence of batch) {
          const scalars = Array.from(evidence.text).length;
          expect(scalars).toBeGreaterThan(0);
          expect(evidence.textStart).toBe(scalarOffset);
          scalarOffset += scalars;
        }
      }
      expect(pdfEvidence.at(-1)?.continuation).toBeUndefined();
      for (let startPage = 1; startPage <= 600; startPage += 25) {
        const batch = pdfEvidence.filter(
          (evidence) => evidence.coverage.startPage === startPage,
        );
        expect(batch.length, `missing native batch ${startPage}`).toBeGreaterThan(2);
        expect(
          batch.filter((evidence) => evidence.continuation).length,
          `batch ${startPage} did not require continuations`,
        ).toBeGreaterThanOrEqual(2);
        expect(batch.at(-1)?.coverage.batchComplete).toBe(true);
      }

      // The structured action result is allowed to be compacted for replay,
      // but every page marker must have entered at least one section prompt.
      const allSections = sectionBodies.join("\n");
      expect(sectionBodies.length).toBeGreaterThan(0);
      for (let page = 1; page <= 600; page += 1) {
        const marker = `PAGE-MARKER-${String(page).padStart(3, "0")}`;
        expect(allSections, `missing ${marker} from section synthesis`).toContain(
          marker,
        );
      }

      const logs = await db
        .select()
        .from(taskLogsTable)
        .where(eq(taskLogsTable.taskId, task.id));
      expect(JSON.stringify(logs)).toMatch(/page|section|synthes/i);

      // The test's metrics are useful when a future implementation regresses
      // into one provider coordination turn per page.
      expect({
        pages: 600,
        providerTurns: providerBodies.length,
        driveSummaryActions: pdfActions.length,
        sectionCalls: sectionBodies.length,
        maxPromptChars: Math.max(
          ...providerBodies.map((body) => JSON.stringify(body).length),
        ),
      }).toEqual(
        expect.objectContaining({
          pages: 600,
        }),
      );
    },
    180_000,
  );

  it("keeps simulated elapsed time beyond 180 seconds distinct from a stuck running task", async () => {
    const agent = await createAgent();
    const task = await insertRunningTask(agent.id);
    let virtualNow = Date.now();
    const realNow = virtualNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
    const fixture = densePdfFixture(600);
    let first = true;

    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/models")) return jsonResponse(PRICING_CATALOG);
      if (target.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "long-pdf-drive-access", expires_in: 3600 });
      }
      if (target.includes("alt=media")) return new Response(fixture);
      if (target.includes("/drive/v3/files/long-pdf-600")) {
        return jsonResponse({
          id: "long-pdf-600",
          name: "dense-600-pages.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-01-01T00:00:00.000Z",
          size: String(fixture.byteLength),
        });
      }
      if (target.includes("chat/completions")) {
        // A handful of bounded provider rounds should still prove that the
        // complete 600-page job is allowed to outlive the old 180-second
        // request-style ceiling.
        // Dense coverage now requires many synthesis calls. Five seconds per
        // call crosses 180s without deliberately exceeding the finite 30min job.
        virtualNow += 5_000;
        if (first) {
          first = false;
          return jsonResponse(
            completion(actionBlock({ fileId: "long-pdf-600", startPage: 1 })),
          );
        }
        // The worker owns every continuation after this one trigger; provider
        // turns after it are synthesis only.
        return jsonResponse(completion("The long summary is complete."));
      }
      throw new Error(`unexpected elapsed-time request: ${target}`);
    });

    try {
      await runTask({ task, agent: await loadAgent(agent.id) });
      expect(virtualNow - realNow).toBeGreaterThan(180_000);
      const settled = await getTask(task.id);
      expect(settled?.status).not.toBe("running");
      expect(settled?.status, settled?.errorMessage ?? undefined).toBe("completed");
    } finally {
      nowSpy.mockRestore();
    }
  }, 180_000);

  it("stops owner cancellation promptly and leaves no long-PDF task running", async () => {
    const agent = await createAgent();
    const task = await insertRunningTask(agent.id);
    const fixture = densePdfFixture(600);
    let cancelled = false;

    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes("/models")) return jsonResponse(PRICING_CATALOG);
      if (target.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "long-pdf-drive-access", expires_in: 3600 });
      }
      if (target.includes("chat/completions")) {
        return jsonResponse(
          completion(actionBlock({ fileId: "long-pdf-600", startPage: 1 })),
        );
      }
      if (target.includes("/drive/v3/files/long-pdf-600")) {
        return jsonResponse({
          id: "long-pdf-600",
          name: "dense-600-pages.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-01-01T00:00:00.000Z",
          size: String(fixture.byteLength),
        });
      }
      if (target.includes("alt=media")) return new Response(fixture);
      throw new Error(`unexpected cancellation request: ${target}`);
    });
    executeMock.mockImplementation(
      async (operation: unknown, params: Record<string, unknown>, context: {
        signal?: AbortSignal;
      }) => {
        if (
          !cancelled &&
          (operation as { name?: string }).name ===
            "google_drive.read_pdf_summary_batch"
        ) {
          cancelled = true;
          const response = await request(app).post(`/api/tasks/${task.id}/cancel`);
          expect(response.status).toBe(200);
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        return actualExecuteOperation.current!(operation, params, context);
      },
    );

    await runTask({ task, agent: await loadAgent(agent.id) });

    const cancelledTask = await getTask(task.id);
    expect(cancelledTask?.status).toBe("cancelled");
    expect(cancelledTask?.status).not.toBe("running");
    expect(cancelledTask?.errorKind).not.toBe("timeout");
    expect(cancelled).toBe(true);
  }, 180_000);
});

function typedEvidence(
  fileId: string,
  startPage: number,
  endPage: number,
  totalPages: number,
  revisionToken: string,
  text: string,
): LongPdfSummaryEvidence {
  return {
    fileId,
    text,
    textStart: startPage === 1 ? 0 : (startPage - 1) * 100_000,
    coverage: {
      startPage,
      endPage,
      totalPages,
      batchComplete: true,
      extractionTruncated: false,
      nextPage: endPage < totalPages ? endPage + 1 : null,
      revisionToken,
    },
  };
}

describe("exported long-PDF checkpoint and stop contracts", () => {
  it("resumes a saved checkpoint successfully without rereading completed sections", async () => {
    const fileId = "checkpoint-pdf";
    const revisionToken = "checkpoint-revision";
    const firstText = "PAGE-MARKER-001 ".repeat(6_000);
    const secondText = "PAGE-MARKER-026 ".repeat(6_000);
    const initialEvidence = typedEvidence(
      fileId,
      1,
      25,
      50,
      revisionToken,
      firstText,
    );
    let saved: LongPdfSummaryCheckpoint | null = null;
    const synthesisRequests: Array<{ startPage: number; endPage: number }> = [];

    await expect(
      runLongPdfSummary({
        checkpoint: null,
        initialEvidence,
        requestedFileId: fileId,
        maxReads: 1,
        readNext: async (request) => {
          expect("continuation" in request).toBe(false);
          expect(request.startPage).toBe(26);
          return typedEvidence(
            fileId,
            26,
            50,
            50,
            revisionToken,
            secondText,
          );
        },
        synthesize: async (request) => {
          synthesisRequests.push({
            startPage: request.startPage,
            endPage: request.endPage,
          });
          return `Saved section ${request.startPage}-${request.endPage}`;
        },
        save: async (checkpoint) => {
          saved = structuredClone(checkpoint);
        },
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({ kind: "limit" });

    expect(saved).not.toBeNull();
    const firstSaved = saved as LongPdfSummaryCheckpoint | null;
    expect(firstSaved?.stage).toBe("traversing");
    expect(firstSaved?.sections.map((section) => [section.startPage, section.endPage]))
      .toContainEqual([1, 25]);
    expect(firstSaved?.nextPage).toBe(26);

    const resumed = await runLongPdfSummary({
      checkpoint: saved,
      requestedFileId: fileId,
      verifyRevision: async () => initialEvidence,
      readNext: async (request) => {
        expect("continuation" in request).toBe(false);
        expect(request.startPage).toBe(26);
        return typedEvidence(
          fileId,
          26,
          50,
          50,
          revisionToken,
          secondText,
        );
      },
      synthesize: async (request) => {
        synthesisRequests.push({
          startPage: request.startPage,
          endPage: request.endPage,
        });
        return `Resumed section ${request.startPage}-${request.endPage}`;
      },
      save: async (checkpoint) => {
        saved = structuredClone(checkpoint);
      },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    });

    expect(resumed.checkpoint.stage).toBe("complete");
    expect(resumed.pagesProcessed).toBe(50);
    expect(resumed.totalPages).toBe(50);
    expect(resumed.output).toMatch(/Resumed|Saved section/);
    expect(synthesisRequests.some((range) => range.startPage === 1)).toBe(true);
    expect(synthesisRequests.some((range) => range.startPage === 26)).toBe(true);
  });

  it("reports controlled runtime expiry and synthesis/read caps as bounded outcomes", async () => {
    const fileId = "bounded-pdf";
    const revisionToken = "bounded-revision";
    let saved: LongPdfSummaryCheckpoint | null = null;
    let now = 0;
    const controller = new AbortController();
    const initialEvidence = typedEvidence(
      fileId,
      1,
      25,
      50,
      revisionToken,
      "PAGE-MARKER-001",
    );

    await expect(
      runLongPdfSummary({
        checkpoint: null,
        initialEvidence,
        requestedFileId: fileId,
        readNext: async () => {
          now = 101;
          return typedEvidence(
            fileId,
            26,
            50,
            50,
            revisionToken,
            "PAGE-MARKER-026",
          );
        },
        synthesize: async () => "bounded section",
        save: async (checkpoint) => {
          saved = structuredClone(checkpoint);
        },
        signal: controller.signal,
        deadlineAt: 100,
        now: () => now,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
    const timeoutSaved = saved as LongPdfSummaryCheckpoint | null;
    expect(timeoutSaved?.stage).toBe("traversing");
    expect(timeoutSaved?.nextPage).toBe(26);
    // The deadline is checked after the transport returns and before its
    // evidence is committed. The durable cursor therefore remains safe to
    // reread, while the already committed page-one evidence remains pending.
    expect(timeoutSaved?.pending.map((chunk) => chunk.startPage)).toContain(1);

    const capped = await runLongPdfSummary({
      checkpoint: null,
      initialEvidence,
      requestedFileId: fileId,
      maxReads: 0,
      readNext: async () => {
        throw new Error("the read cap must prevent this call");
      },
      synthesize: async () => "unreachable",
      save: async () => {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    }).catch((error: unknown) => error);
    expect(capped).toBeInstanceOf(LongPdfSummaryError);
    expect((capped as LongPdfSummaryError).kind).toBe("limit");
    expect((capped as LongPdfSummaryError).message).toMatch(/Drive-read limit/i);
  });

  it("rejects a revoked revision before trusting saved reduction evidence", async () => {
    const fileId = "revoked-pdf";
    const checkpoint = {
      version: 1 as const,
      fileId,
      revisionToken: "old-revision",
      totalPages: 1,
      jobDeadlineAt: Date.now() + 60_000,
      nextPage: null,
      continuation: null,
      expectedTextStart: null,
      completedThroughPage: 1,
      pending: [],
      sections: [{
        startPage: 1,
        endPage: 1,
        textScalars: 20,
        chunks: [{
          startPage: 1,
          endPage: 1,
          textStart: 0,
          textScalars: 20,
        }],
        summary: "old section",
      }],
      reduction: null,
      pendingSynthesis: null,
      readCount: 1,
      synthesisCount: 1,
      stage: "complete" as const,
      finalSummary: "old summary",
    };
    const revoked = await runLongPdfSummary({
      checkpoint,
      requestedFileId: fileId,
      verifyRevision: async () =>
        typedEvidence(fileId, 1, 1, 1, "new-revision", "new text"),
      readNext: async () => {
        throw new Error("revoked checkpoint must not read");
      },
      synthesize: async () => "unreachable",
      save: async () => {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    }).catch((error: unknown) => error);

    expect(revoked).toBeInstanceOf(LongPdfSummaryError);
    expect((revoked as LongPdfSummaryError).kind).toBe("revision_changed");
    expect((revoked as LongPdfSummaryError).message).toMatch(/changed/i);
  });
});
/**
 * Real-PDF ingress regressions.
 *
 * This suite intentionally uses the production PDF.js child-process extractor,
 * rather than mocking it: routes must persist extracted text once and carry
 * that durable representation through Talk's proposal/confirmation path.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentMessagesTable,
  agentsTable,
  db,
  pool,
  talkExchangesTable,
  tasksTable,
  teamsTable,
  workspacesTable,
} from "@workspace/db";
import { eq, inArray, or } from "drizzle-orm";

const authState = vi.hoisted(() => ({ userId: "" }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: authState.userId }),
}));
vi.stubGlobal("fetch", fetchMock);

import officeRouter from "./office";
import * as pdfExtractor from "../pdf/extract";
import { clearProviderCaches } from "../providers";
import { saveProviderCredential } from "../provider-credentials";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: { warn: () => void } }).log = { warn: () => {} };
  next();
});
app.use("/api", officeRouter);

const RUN_TAG = `HC PDF ingress ${Date.now()}`;
const PDF_MARKER = "PDF-ROUTE-EXTRACTION-MARKER-917";
const RAW_PDF = pdfFixture([`BT /F1 12 Tf 72 720 Td (${PDF_MARKER}) Tj ET`]);
const PDF_ATTACHMENT = {
  name: "route-evidence.pdf",
  mimeType: "application/pdf",
  encoding: "base64" as const,
  content: Buffer.from(RAW_PDF).toString("base64"),
};

let workspaceId = "";
let foreignWorkspaceId = "";
let ownerId = "";
let foreignOwnerId = "";
const createdAgentIds: string[] = [];
const createdTeamIds: string[] = [];

/**
 * Small deterministic PDF syntax, deliberately not a fixture-generator
 * output. PDF.js parses this through the same isolated extractor as ingress.
 */
function pdfFixture(pageStreams: string[]): Uint8Array {
  const objects: string[] = [];
  const pageObjectIds = pageStreams.map((_, index) => 3 + index * 2);
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`,
  );
  for (const [index, stream] of pageStreams.entries()) {
    const pageId = pageObjectIds[index]!;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pageStreams.length * 2 + 3} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId] =
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  }
  const fontId = pageStreams.length * 2 + 3;
  objects[fontId - 1] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

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
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

async function createAgent(name: string) {
  const res = await request(app)
    .post("/api/agents")
    .send({
      name: `${RUN_TAG} ${name}`,
      title: "PDF ingress tester",
      mission: "Verify a real PDF remains extracted text at every boundary.",
      provider: "openrouter",
      model: "test-vendor/test-model",
      securityPreset: "assistant",
      autonomy: "autonomous",
      permissionOverrides: {
        maxTaskBudgetCents: null,
        dailyBudgetCents: null,
        maxTasksPerDay: null,
      },
      avatar: { shellColor: "#C34428", deskStyle: "standard", accessory: "none" },
    });
  expect(res.status).toBe(201);
  createdAgentIds.push(res.body.id);
  // Never leave a route-created queued row available to the live worker.
  const paused = await request(app)
    .post(`/api/agents/${res.body.id}/pause`)
    .send({ paused: true });
  expect(paused.status).toBe(200);
  return res.body as { id: string; name: string };
}

function completion(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "pdf-ingress-test-secret");
  ownerId = `pdf-ingress-owner-${Date.now()}`;
  foreignOwnerId = `pdf-ingress-foreign-${Date.now()}`;
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: ownerId })
    .returning({ id: workspacesTable.id });
  const [foreignWorkspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: foreignOwnerId })
    .returning({ id: workspacesTable.id });
  workspaceId = workspace!.id;
  foreignWorkspaceId = foreignWorkspace!.id;
  authState.userId = ownerId;
  await saveProviderCredential(workspaceId, "openrouter", "pdf-ingress-openrouter-key");
  await saveProviderCredential(
    foreignWorkspaceId,
    "openrouter",
    "pdf-ingress-foreign-openrouter-key",
  );
});

beforeEach(() => {
  authState.userId = ownerId;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown) => {
    throw new Error(`network disabled in PDF ingress test: ${String(url)}`);
  });
  clearProviderCaches();
});

afterAll(async () => {
  if (createdAgentIds.length > 0) {
    await db
      .delete(agentMessagesTable)
      .where(
        or(
          inArray(agentMessagesTable.fromAgentId, createdAgentIds),
          inArray(agentMessagesTable.toAgentId, createdAgentIds),
        ),
      );
    await db.delete(tasksTable).where(inArray(tasksTable.agentId, createdAgentIds));
  }
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds));
  }
  if (createdAgentIds.length > 0) {
    await db.delete(agentsTable).where(inArray(agentsTable.id, createdAgentIds));
  }
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await db
    .delete(workspacesTable)
    .where(eq(workspacesTable.id, foreignWorkspaceId));
  vi.unstubAllEnvs();
  await pool.end();
});

describe("real PDF task and Talk ingress", () => {
  it("stores extracted text on create and preserves it on retry without parsing again", async () => {
    const agent = await createAgent("task owner");
    const created = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: "Summarize the attached PDF.",
      attachments: [PDF_ATTACHMENT],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.files).toEqual([
      expect.objectContaining({
        name: "route-evidence.pdf.txt",
        content: expect.stringContaining(PDF_MARKER),
      }),
    ]);

    const [stored] = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, created.body.id))
      .limit(1);
    expect(stored?.files).toEqual([
      expect.objectContaining({
        name: "route-evidence.pdf.txt",
        mimeType: "text/plain",
        encoding: "text",
        content: expect.stringContaining(PDF_MARKER),
      }),
    ]);
    expect(JSON.stringify(stored?.files)).not.toContain(PDF_ATTACHMENT.content);

    await db
      .update(tasksTable)
      .set({ status: "failed", attempts: 1, errorKind: "provider_error" })
      .where(eq(tasksTable.id, created.body.id));
    const extractSpy = vi.spyOn(pdfExtractor, "extractPdfText");
    try {
      const retried = await request(app).post(`/api/tasks/${created.body.id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body.files).toEqual(created.body.files);
      const [retriedStored] = await db
        .select({ files: tasksTable.files })
        .from(tasksTable)
        .where(eq(tasksTable.id, created.body.id))
        .limit(1);
      expect(retriedStored?.files).toEqual(stored?.files);
      expect(extractSpy).not.toHaveBeenCalled();
    } finally {
      extractSpy.mockRestore();
    }
  });

  it("keeps only position-mapped PDF text in a Talk proposal while confirmation retains mixed originals", async () => {
    const lead = await createAgent("Talk lead");
    const target = await createAgent("Talk target");
    const team = await request(app)
      .post("/api/teams")
      .send({
        name: `${RUN_TAG} PDF Talk team`,
        leadAgentId: lead.id,
        memberAgentIds: [lead.id, target.id],
      });
    expect(team.status).toBe(201);
    createdTeamIds.push(team.body.id);

    fetchMock.mockImplementation(async (url: unknown) => {
      if (!String(url).includes("/chat/completions")) {
        throw new Error(`unexpected provider URL: ${String(url)}`);
      }
      return completion({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "I can hand that PDF review to my teammate.",
                taskObjective: null,
                agentRequest: {
                  targetAgentId: target.id,
                  kind: "task",
                  content: "Review the attached PDF and report its marker.",
                },
                taskResultsQuery: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    });

    const extractSpy = vi.spyOn(pdfExtractor, "extractPdfText");
    try {
      // Use an ordinary file with the exact canonical PDF filename as a
      // collision guard. The response's index map, not names, must decide
      // which file is replaced.
      const ordinaryText = {
        name: "route-evidence.pdf.txt",
        mimeType: "text/plain",
        encoding: "text" as const,
        content: "UNCHANGED-TEXT-MUST-STAY-CLIENT-SIDE",
      };
      const image = {
        name: "evidence.png",
        mimeType: "image/png",
        encoding: "base64" as const,
        content: Buffer.from("ordinary image bytes").toString("base64"),
      };
      const attached = [ordinaryText, PDF_ATTACHMENT, image];
      const clientMessageId = crypto.randomUUID();
      const proposal = await request(app)
        .post(`/api/agents/${lead.id}/converse`)
        .send({
          text: "Please ask the teammate to review this.",
          clientMessageId,
          attachments: attached,
        });
      expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
      expect(proposal.body.proposedDelegation).toMatchObject({
        targetAgentId: target.id,
        objective: "Review the attached PDF and report its marker.",
      });
      expect(proposal.body.normalizedAttachments).toEqual([
        expect.objectContaining({
          name: "route-evidence.pdf.txt",
          mimeType: "text/plain",
          encoding: "text",
          content: expect.stringContaining(PDF_MARKER),
        }),
      ]);
      expect(proposal.body.normalizedAttachmentIndices).toEqual([1]);
      // The response and durable idempotency cache never mirror ordinary
      // files. The browser retains them locally until the owner confirms.
      expect(JSON.stringify(proposal.body)).not.toContain(ordinaryText.content);
      expect(JSON.stringify(proposal.body)).not.toContain(image.content);
      expect(proposal.body.normalizedUserText).toEqual(
        expect.stringContaining(PDF_MARKER),
      );
      expect(proposal.body.normalizedUserText).not.toContain(
        ordinaryText.content,
      );
      const [cachedProposal] = await db
        .select({ responseJson: talkExchangesTable.responseJson })
        .from(talkExchangesTable)
        .where(eq(talkExchangesTable.clientMessageId, clientMessageId))
        .limit(1);
      expect(cachedProposal?.responseJson).toBeDefined();
      expect(cachedProposal?.responseJson).not.toContain(ordinaryText.content);
      expect(cachedProposal?.responseJson).not.toContain(image.content);

      const history = await request(app).get(`/api/agents/${lead.id}/talk-history`);
      expect(history.status).toBe(200);
      expect(history.body.turns.map((turn: { text: string }) => turn.text)).toEqual(
        expect.arrayContaining([
          "Please ask the teammate to review this.",
          "I can hand that PDF review to my teammate.",
        ]),
      );
      const persistedUserTurn = history.body.turns.find(
        (turn: { role: string; text: string }) =>
          turn.role === "user" &&
          turn.text === "Please ask the teammate to review this.",
      );
      // Reloaded history keeps the visible conversation unchanged but carries
      // bounded normalized attachment text as the next-turn provider context.
      expect(persistedUserTurn?.contextText).toEqual(
        expect.stringContaining(PDF_MARKER),
      );

      const followUp = await request(app)
        .post(`/api/agents/${lead.id}/converse`)
        .send({
          text: "What exact marker did the document contain?",
          clientMessageId: crypto.randomUUID(),
          // This reproduces the Call view after a reload: no attachment is
          // sent again, only the durable context returned by talk-history.
          history: history.body.turns.map(
            (turn: {
              role: "user" | "agent";
              text: string;
              contextText?: string;
            }) => ({
              role: turn.role,
              text: turn.contextText ?? turn.text,
            }),
          ),
        });
      expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
      const followUpProviderPayload = JSON.parse(
        String(fetchMock.mock.calls.at(-1)?.[1]?.body),
      );
      const followUpPrompt = JSON.stringify(followUpProviderPayload.messages);
      expect(followUpPrompt).toContain(PDF_MARKER);
      expect(followUpPrompt).not.toContain(PDF_ATTACHMENT.content);

      const confirmationAttachments = attached.map((attachment, index) => {
        const replacementIndex = proposal.body.normalizedAttachmentIndices.indexOf(
          index,
        );
        return replacementIndex === -1
          ? attachment
          : proposal.body.normalizedAttachments[replacementIndex];
      });
      const confirmed = await request(app)
        .post(`/api/agents/${lead.id}/delegate-from-talk`)
        .send({
          targetAgentId: proposal.body.proposedDelegation.targetAgentId,
          objective: proposal.body.proposedDelegation.objective,
          note: proposal.body.proposedDelegation.note,
          // This is exactly the position-indexed merge the Talk client sends:
          // original images/text remain while PDFs use extracted text.
          attachments: confirmationAttachments,
        });
      expect(confirmed.status).toBe(201);
      // Task API responses redact image bytes, but the three original
      // attachment positions still reach the proposal in order.
      expect(confirmed.body.files).toEqual([
        expect.objectContaining({
          name: ordinaryText.name,
          content: ordinaryText.content,
        }),
        expect.objectContaining({
          name: "route-evidence.pdf.txt",
          content: expect.stringContaining(PDF_MARKER),
        }),
        expect.objectContaining({
          name: image.name,
          content: "[image/png attachment]",
        }),
      ]);
      const [stored] = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, confirmed.body.id))
        .limit(1);
      expect(stored?.files).toEqual(confirmationAttachments);
      // The confirmation normalizes already-extracted text, never the PDF.
      expect(extractSpy).toHaveBeenCalledTimes(1);
    } finally {
      extractSpy.mockRestore();
    }
  });

  it("bounds durable Talk document context with an explicit omission marker", async () => {
    const agent = await createAgent("Talk history cap");
    const largePdfAttachment = {
      name: "long-talk-evidence.pdf",
      mimeType: "application/pdf",
      encoding: "base64" as const,
      content: Buffer.from(
        // PDF.js emits a bounded number of glyph items per page, so spread
        // the long document across pages rather than one giant text operator.
        pdfFixture(
          Array.from(
            { length: 50 },
            (_, page) =>
              `BT /F1 12 Tf 72 720 Td (${page === 0 ? `${PDF_MARKER} ` : ""}${"x ".repeat(180)}) Tj ET`,
          ),
        ),
      ).toString("base64"),
    };
    fetchMock.mockImplementation(async (url: unknown) => {
      if (!String(url).includes("/chat/completions")) {
        throw new Error(`unexpected provider URL: ${String(url)}`);
      }
      return completion({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "I received the report.",
                taskObjective: null,
                agentRequest: null,
                taskResultsQuery: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    });

    const response = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({
        text: "Please retain this report for our next discussion.",
        clientMessageId: crypto.randomUUID(),
        attachments: [largePdfAttachment],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.normalizedUserText.length).toBe(8_000);
    expect(response.body.normalizedUserText).toContain(
      "ATTACHMENT TEXT OMITTED FROM TALK HISTORY",
    );

    const history = await request(app).get(`/api/agents/${agent.id}/talk-history`);
    expect(history.status).toBe(200);
    const userTurn = history.body.turns.find(
      (turn: { role: string }) => turn.role === "user",
    );
    expect(userTurn.text).toBe("Please retain this report for our next discussion.");
    expect(userTurn.contextText).toBe(response.body.normalizedUserText);
  });

  it("denies a foreign agent before it starts PDF parsing", async () => {
    authState.userId = foreignOwnerId;
    const foreignAgent = await createAgent("foreign owner");
    authState.userId = ownerId;
    const localAgent = await createAgent("local delegation");

    const extractSpy = vi.spyOn(pdfExtractor, "extractPdfText");
    try {
      const denied = await request(app).post("/api/tasks").send({
        agentId: foreignAgent.id,
        objective: "This foreign request must not inspect a PDF.",
        attachments: [PDF_ATTACHMENT],
      });
      expect(denied.status).toBe(404);
      const foreignTarget = await request(app)
        .post(`/api/agents/${localAgent.id}/delegate-from-talk`)
        .send({
          targetAgentId: foreignAgent.id,
          objective: "This foreign hand-off must not inspect a PDF.",
          attachments: [PDF_ATTACHMENT],
        });
      expect(foreignTarget.status).toBe(404);
      const foreignSource = await request(app)
        .post(`/api/agents/${foreignAgent.id}/delegate-from-talk`)
        .send({
          targetAgentId: localAgent.id,
          objective: "This foreign source must not inspect a PDF.",
          attachments: [PDF_ATTACHMENT],
        });
      expect(foreignSource.status).toBe(404);
      expect(extractSpy).not.toHaveBeenCalled();
    } finally {
      extractSpy.mockRestore();
    }
  });
});
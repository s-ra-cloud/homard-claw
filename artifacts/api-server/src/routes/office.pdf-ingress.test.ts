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
  workspaceSettingsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";

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

/** Minimal stored ZIP package for the real isolated DOCX parser. */
function docxFixture(text: string): Uint8Array {
  const files: Array<[string, string]> = [
    [
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ],
    [
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ];
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of files) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(value);
    const header = Buffer.alloc(30);
    const record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, content);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
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

  it("retains canonical DOCX text through a later proposal, reload, task confirmation, and clear without cross-workspace leakage", async () => {
    const agent = await createAgent("DOCX retained context");
    const docxMarker = "DOCX-RETAINED-CANONICAL-MARKER";
    const docxTail = "DOCX-RETAINED-CANONICAL-TAIL";
    const rawDocx = Buffer.from(
      docxFixture(`${docxMarker} ${"x".repeat(12_000)} ${docxTail}`),
    ).toString("base64");
    const attachment = {
      name: "later-proposal.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      encoding: "base64" as const,
      content: rawDocx,
    };
    let proposeTask = false;
    fetchMock.mockImplementation(async (url: unknown) => {
      if (!String(url).includes("/chat/completions")) {
        throw new Error(`unexpected provider URL: ${String(url)}`);
      }
      return completion({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: proposeTask
                  ? "I can queue a review of that document."
                  : "I have retained the document for the next step.",
                taskObjective: proposeTask
                  ? "Review the retained DOCX document."
                  : null,
                agentRequest: null,
                taskResultsQuery: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    });

    const firstMessageId = crypto.randomUUID();
    const upload = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({
        text: "Read this DOCX, but do not create a task yet.",
        clientMessageId: firstMessageId,
        attachments: [attachment],
      });
    expect(upload.status, JSON.stringify(upload.body)).toBe(200);
    expect(upload.body.proposedTaskObjective).toBeNull();
    // No proposal means the browser has no attachment to keep. The server's
    // private canonical context, not the 8k history excerpt, is authoritative.
    expect(upload.body.normalizedAttachments).toBeUndefined();
    expect(upload.body.normalizedUserText).toHaveLength(8_000);
    expect(upload.body.normalizedUserText).toContain(
      "ATTACHMENT TEXT OMITTED FROM TALK HISTORY",
    );

    const [storedContext] = await db
      .select({ value: workspaceSettingsTable.value })
      .from(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, workspaceId),
          eq(
            workspaceSettingsTable.key,
            `talk_document_context:${agent.id}`,
          ),
        ),
      )
      .limit(1);
    expect(storedContext?.value).toContain(docxMarker);
    expect(storedContext?.value).toContain(docxTail);
    expect(storedContext?.value.length).toBeGreaterThan(8_000);
    expect(storedContext?.value.length).toBeLessThanOrEqual(405_024);
    expect(storedContext?.value).not.toContain(rawDocx);
    const [cachedUpload] = await db
      .select({ responseJson: talkExchangesTable.responseJson })
      .from(talkExchangesTable)
      .where(eq(talkExchangesTable.clientMessageId, firstMessageId))
      .limit(1);
    expect(cachedUpload?.responseJson).not.toContain(rawDocx);

    // A reload exposes the usual bounded transcript only.
    const history = await request(app).get(`/api/agents/${agent.id}/talk-history`);
    expect(history.status).toBe(200);
    expect(
      history.body.turns.find(
        (turn: { role: string }) => turn.role === "user",
      )?.contextText,
    ).toEqual(expect.stringContaining(docxMarker));

    // Store a distinct document in another workspace. A later local proposal
    // must receive only this workspace/agent's canonical document.
    authState.userId = foreignOwnerId;
    const foreignAgent = await createAgent("foreign DOCX retained context");
    const foreignRaw = Buffer.from(docxFixture("FOREIGN-DOCX-MUST-NOT-LEAK")).toString(
      "base64",
    );
    const foreignUpload = await request(app)
      .post(`/api/agents/${foreignAgent.id}/converse`)
      .send({
        text: "Keep this other document.",
        clientMessageId: crypto.randomUUID(),
        attachments: [
          {
            ...attachment,
            name: "foreign.docx",
            content: foreignRaw,
          },
        ],
      });
    expect(foreignUpload.status, JSON.stringify(foreignUpload.body)).toBe(200);
    authState.userId = ownerId;

    proposeTask = true;
    const proposal = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({
        text: "Now create the task from the document.",
        clientMessageId: crypto.randomUUID(),
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
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    expect(proposal.body.normalizedAttachmentIndices).toBeUndefined();
    expect(proposal.body.normalizedAttachments).toEqual([
      expect.objectContaining({
        name: "later-proposal.docx.txt",
        mimeType: "text/plain",
        encoding: "text",
        content: expect.stringContaining(docxTail),
      }),
    ]);
    expect(proposal.body.documentContextVersion).toEqual(expect.any(String));
    expect(JSON.stringify(proposal.body)).not.toContain("FOREIGN-DOCX-MUST-NOT-LEAK");
    expect(JSON.stringify(proposal.body)).not.toContain(rawDocx);

    const confirmed = await request(app).post("/api/tasks").send({
      agentId: agent.id,
      objective: proposal.body.proposedTaskObjective,
      talkMode: true,
      attachments: proposal.body.normalizedAttachments,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    const [confirmedTask] = await db
      .select({ files: tasksTable.files })
      .from(tasksTable)
      .where(eq(tasksTable.id, confirmed.body.id))
      .limit(1);
    expect(confirmedTask?.files).toEqual([
      expect.objectContaining({ content: expect.stringContaining(docxTail) }),
    ]);
    expect(JSON.stringify(confirmedTask?.files)).not.toContain(rawDocx);

    // Simulate B arriving before A's fire-and-forget confirmation cleanup.
    // A document-bearing turn deterministically replaces the retained state.
    proposeTask = true;
    const replacementMarker = "DOCX-RETAINED-CONTEXT-B-MUST-SURVIVE-A-CLEANUP";
    const secondUpload = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({
        text: "Keep it for a later proposal once more.",
        clientMessageId: crypto.randomUUID(),
        attachments: [
          {
            ...attachment,
            name: "newer-document.docx",
            content: Buffer.from(docxFixture(replacementMarker)).toString("base64"),
          },
        ],
      });
    expect(secondUpload.status, JSON.stringify(secondUpload.body)).toBe(200);
    expect(secondUpload.body.documentContextVersion).toEqual(expect.any(String));
    expect(secondUpload.body.documentContextVersion).not.toBe(
      proposal.body.documentContextVersion,
    );
    // Simulate A's fire-and-forget confirmation cleanup arriving only after a
    // new document-bearing turn B. The old opaque generation may not erase B.
    const delayedOldCleanup = await request(app)
      .delete(`/api/agents/${agent.id}/talk-document-context`)
      .send({ version: proposal.body.documentContextVersion });
    expect(delayedOldCleanup.status).toBe(409);
    const [afterDelayedCleanup] = await db
      .select({ value: workspaceSettingsTable.value })
      .from(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, workspaceId),
          eq(
            workspaceSettingsTable.key,
            `talk_document_context:${agent.id}`,
          ),
        ),
      )
      .limit(1);
    expect(afterDelayedCleanup?.value).toContain(replacementMarker);

    // The current generation may still be consumed after confirmation or a
    // dismissal without erasing the ordinary Talk transcript.
    const consumed = await request(app)
      .delete(`/api/agents/${agent.id}/talk-document-context`)
      .send({ version: secondUpload.body.documentContextVersion });
    expect(consumed.status).toBe(204);

    // Recreate bounded state, then ensure the existing history clear removes
    // it atomically with transcript and idempotency data.
    proposeTask = false;
    const thirdUpload = await request(app)
      .post(`/api/agents/${agent.id}/converse`)
      .send({
        text: "Keep one last document until history is cleared.",
        clientMessageId: crypto.randomUUID(),
        attachments: [attachment],
      });
    expect(thirdUpload.status, JSON.stringify(thirdUpload.body)).toBe(200);
    const cleared = await request(app).delete(`/api/agents/${agent.id}/talk-history`);
    expect(cleared.status).toBe(200);
    const [afterClear] = await db
      .select({ value: workspaceSettingsTable.value })
      .from(workspaceSettingsTable)
      .where(
        and(
          eq(workspaceSettingsTable.workspaceId, workspaceId),
          eq(
            workspaceSettingsTable.key,
            `talk_document_context:${agent.id}`,
          ),
        ),
      )
      .limit(1);
    expect(afterClear).toBeUndefined();
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
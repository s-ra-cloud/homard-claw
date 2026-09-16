/**
 * The final provider boundary must normalize a real PDF for every adapter.
 * HTTP providers are stubs and Codex's SDK turn is stubbed: no test traffic
 * can leave this process.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, workspacesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const fetchMock = vi.hoisted(() => vi.fn());
const runCodexTurn = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

vi.mock("./codex/execute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex/execute")>();
  return { ...actual, runCodexTurn };
});

import { callProvider } from "./execution";
import { saveProviderCredential } from "./provider-credentials";

const PDF_MARKER = "PDF-PROVIDER-EXTRACTION-MARKER-618";
const RAW_PDF = pdfFixture([`BT /F1 12 Tf 72 720 Td (${PDF_MARKER}) Tj ET`]);
const RAW_BASE64 = Buffer.from(RAW_PDF).toString("base64");
const PDF_ATTACHMENT = {
  name: "provider-evidence.pdf",
  mimeType: "application/pdf",
  encoding: "base64" as const,
  content: RAW_BASE64,
};

let workspaceId = "";
let codexDirectory = "";

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "execution-pdf-test-secret");
  const [workspace] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `execution-pdf-${Date.now()}` })
    .returning({ id: workspacesTable.id });
  workspaceId = workspace!.id;
  codexDirectory = await mkdtemp(path.join(os.tmpdir(), "hc-pdf-codex-"));
  await saveProviderCredential(workspaceId, "claude_max", "execution-pdf-claude");
  await saveProviderCredential(
    workspaceId,
    "openrouter",
    "execution-pdf-openrouter",
  );
});

beforeEach(() => {
  fetchMock.mockReset();
  runCodexTurn.mockReset();
});

afterAll(async () => {
  await rm(codexDirectory, { recursive: true, force: true });
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  vi.unstubAllEnvs();
  await pool.end();
});

describe("callProvider real PDF normalization", () => {
  it("sends extracted text—not PDF bytes—to Claude, OpenRouter, and Codex", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes("anthropic.com")) {
        return jsonResponse({
          content: [{ type: "text", text: "Claude received the text." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (target.includes("openrouter.ai")) {
        return jsonResponse({
          choices: [{ message: { content: "OpenRouter received the text." } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      throw new Error(`unexpected network target: ${target}`);
    });
    runCodexTurn.mockResolvedValue({
      output: "Codex received the text.",
      usage: { input_tokens: 1, output_tokens: 1 },
      threadId: "thread-pdf-test",
    });

    const common = {
      workspaceId,
      model: "test-model",
      system: "You are a provider PDF test.",
      prompt: "Summarize the attached report.",
      attachments: [PDF_ATTACHMENT],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    };
    await callProvider({ ...common, provider: "claude_max" });
    await callProvider({ ...common, provider: "openrouter" });
    await callProvider({
      ...common,
      provider: "codex_chatgpt",
      clerkUserId: "execution-pdf-codex-user",
      workingDirectory: codexDirectory,
      sandbox: { securityPreset: "assistant", autonomy: "autonomous" },
    });

    const claudeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("anthropic.com"),
    );
    const claudePayload = JSON.parse(String(claudeCall?.[1]?.body));
    const claudePrompt = JSON.stringify(claudePayload.messages[0].content);
    expect(claudePrompt).toContain(PDF_MARKER);
    expect(claudePrompt).not.toContain(RAW_BASE64);
    expect(claudePrompt).not.toContain("%PDF");

    const openRouterCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("openrouter.ai"),
    );
    const openRouterPayload = JSON.parse(String(openRouterCall?.[1]?.body));
    const openRouterPrompt = JSON.stringify(openRouterPayload.messages[1].content);
    expect(openRouterPrompt).toContain(PDF_MARKER);
    expect(openRouterPrompt).not.toContain(RAW_BASE64);
    expect(openRouterPrompt).not.toContain("%PDF");

    expect(runCodexTurn).toHaveBeenCalledTimes(1);
    const codexPrompt = String(runCodexTurn.mock.calls[0]?.[0]?.prompt);
    expect(codexPrompt).toContain(PDF_MARKER);
    expect(codexPrompt).not.toContain(RAW_BASE64);
    expect(codexPrompt).not.toContain("%PDF");
  });

  it("keeps canonical PDF text inline for generic and maximum-length sources", async () => {
    runCodexTurn.mockResolvedValue({
      output: "Codex received the text.",
      usage: { input_tokens: 1, output_tokens: 1 },
      threadId: "thread-pdf-source-label-test",
    });
    const longSourceName = `${"a".repeat(156)}.pdf`;
    await callProvider({
      workspaceId,
      provider: "codex_chatgpt",
      clerkUserId: "execution-pdf-codex-user",
      model: "test-model",
      system: "You are a provider PDF test.",
      prompt: "Summarize the attached reports.",
      attachments: [
        {
          ...PDF_ATTACHMENT,
          name: "upload.bin",
          mimeType: "application/octet-stream",
        },
        { ...PDF_ATTACHMENT, name: longSourceName },
      ],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      workingDirectory: codexDirectory,
      sandbox: { securityPreset: "assistant", autonomy: "autonomous" },
    });

    const codexPrompt = String(runCodexTurn.mock.calls[0]?.[0]?.prompt);
    expect(codexPrompt).toContain(
      "--- SOURCE PDF FILENAME: upload.bin ---",
    );
    expect(codexPrompt).toContain(
      `--- ATTACHED DOCUMENT: upload.bin (text/plain) ---`,
    );
    expect(codexPrompt).toContain(
      `--- SOURCE PDF FILENAME: ${longSourceName} ---`,
    );
    expect(codexPrompt).toContain(
      `--- ATTACHED DOCUMENT: ${longSourceName} (text/plain) ---`,
    );
    expect(codexPrompt).toContain(PDF_MARKER);
  });

  it("materializes an ordinary large text attachment instead of inlining it", async () => {
    runCodexTurn.mockResolvedValue({
      output: "Codex read the workspace file.",
      usage: { input_tokens: 1, output_tokens: 1 },
      threadId: "thread-text-file-test",
    });
    // Larger than the bounded canonical-PDF context allowance, while still a
    // valid ordinary text file under the 25 MB attachment allowance.
    const largeText = `ORDINARY-TEXT-FILE-MARKER\n${"x".repeat(102_000)}`;
    await callProvider({
      workspaceId,
      provider: "codex_chatgpt",
      clerkUserId: "execution-pdf-codex-user",
      model: "test-model",
      system: "You are a provider attachment test.",
      prompt: "Review the attached notes.",
      attachments: [
        {
          name: "notes.txt",
          mimeType: "text/plain",
          encoding: "text",
          content: largeText,
        },
      ],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      workingDirectory: codexDirectory,
      sandbox: { securityPreset: "assistant", autonomy: "autonomous" },
    });

    const codexPrompt = String(runCodexTurn.mock.calls[0]?.[0]?.prompt);
    expect(codexPrompt).toContain(
      "notes.txt: .homardclaw-attachments/1-notes.txt",
    );
    expect(codexPrompt).not.toContain("ORDINARY-TEXT-FILE-MARKER");
    await expect(
      readFile(
        path.join(
          codexDirectory,
          ".homardclaw-attachments",
          "1-notes.txt",
        ),
        "utf8",
      ),
    ).resolves.toBe(largeText);
  });
});
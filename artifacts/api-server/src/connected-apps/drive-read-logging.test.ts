import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeOperation,
  UNEXPECTED_APP_ERROR_MESSAGE,
} from "./connections";
import { findOperation } from "./catalog";
import * as googleCredentials from "../google/credentials";
import { logger } from "../lib/logger";

describe("google_drive.read_file production diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("logs safe stage and completion records with task/action/workspace context", async () => {
    const infoSpy = vi.spyOn(logger, "info");

    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        requestCount++ === 0
          ? new Response(
              JSON.stringify({
                id: "secret-file-id",
                name: "private-file-name",
                mimeType: "text/plain",
              }),
            )
          : new Response("private file body"),
    );

    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-file-id" },
      {
        taskId: "task-drive-log",
        actionId: "action-drive-log",
        workspaceId: "workspace-drive-log",
      },
    );

    expect(outcome.ok).toBe(true);
    expect(requestCount).toBe(2);
    const driveCalls = infoSpy.mock.calls.filter(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).component === "google_drive_read",
    );
    expect(driveCalls.length).toBeGreaterThan(0);
    const stages = driveCalls.map(
      ([fields]) => (fields as Record<string, unknown>).stage,
    );
    expect(stages).toContain("credentials");
    expect(stages).toContain("metadata");
    expect(stages).toContain("download");
    expect(stages).toContain("complete");
    const completion = driveCalls.find(
      ([fields]) => (fields as Record<string, unknown>).stage === "complete",
    )![0] as Record<string, unknown>;
    expect(completion).toMatchObject({
      taskId: "task-drive-log",
      actionId: "action-drive-log",
      workspaceId: "workspace-drive-log",
      status: "success",
    });
    expect(completion.durationMs).toEqual(expect.any(Number));
    expect(completion.stageDurationMs).toEqual(expect.any(Number));
    const serialized = JSON.stringify(driveCalls);
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("secret-file-id");
    expect(serialized).not.toContain("private-file-name");
    expect(serialized).not.toContain("private file body");
  });

  it("logs only failure class and provider status on a raw Drive refusal", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            error: {
              errors: [
                {
                  reason: "insufficientPermissions",
                  message: "private file details must not be logged",
                },
              ],
            },
          }),
          { status: 403 },
        ),
    );

    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-file-id" },
      {
        taskId: "task-drive-failure",
        actionId: "action-drive-failure",
        workspaceId: "workspace-drive-failure",
      },
    );

    expect(outcome.ok).toBe(false);
    const failureCall = warnSpy.mock.calls.find(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        (fields as Record<string, unknown>).component === "google_drive_read",
    );
    expect(failureCall).toBeDefined();
    const fields = failureCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      taskId: "task-drive-failure",
      actionId: "action-drive-failure",
      workspaceId: "workspace-drive-failure",
      stage: "failure",
      status: "failed",
      failureClass: "permission",
      providerStatus: 403,
    });
    expect(fields.durationMs).toEqual(expect.any(Number));
    expect(fields.stageDurationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "private file details",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("secret-file-id");
  });

  it("extracts a real PDF through the executor without logging source or text", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const fixture = pdfFixture("Executor PDF fixture");
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async () => requestCount++ === 0
      ? new Response(JSON.stringify({
          id: "secret-pdf-id",
          name: "deterministic-report.pdf",
          mimeType: "application/pdf",
        }))
      : new Response(fixture));
    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-pdf-id" },
      {
        taskId: "task-drive-pdf",
        actionId: "action-drive-pdf",
        workspaceId: "workspace-drive-pdf",
      },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain('"deterministic-report.pdf"');
      expect(outcome.summary).toContain("--- Page 1 (text only;");
      expect(outcome.summary).toContain("Executor PDF fixture");
      expect(outcome.summary).not.toContain("%PDF-");
    }
    expect(requestCount).toBe(2);
    expect(infoSpy.mock.calls.some(([fields]) =>
      typeof fields === "object" && fields !== null &&
      (fields as Record<string, unknown>).stage === "extract")).toBe(true);
    const logs = JSON.stringify([infoSpy.mock.calls, warnSpy.mock.calls]);
    for (const marker of ["secret-access-token", "secret-pdf-id",
      "deterministic-report.pdf", "Executor PDF fixture"]) {
      expect(logs).not.toContain(marker);
    }
  });

  it("keeps parser rejection outcomes and diagnostics content-free", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const privateMarker = "PRIVATE PDF BODY";
    vi.spyOn(googleCredentials, "driveAccessToken").mockResolvedValue({
      token: "secret-access-token",
      email: "owner@example.com",
      googleSub: "google-sub",
    });
    let requestCount = 0;
    vi.stubGlobal("fetch", async () => requestCount++ === 0
      ? new Response(JSON.stringify({
          id: "secret-pdf-id",
          name: "private-payroll.pdf",
          mimeType: "application/pdf",
        }))
      : new Response(`%PDF-${privateMarker}`));
    const outcome = await executeOperation(
      findOperation("google_drive.read_file")!,
      { fileId: "secret-pdf-id" },
      {
        taskId: "task-drive-pdf-rejection",
        actionId: "action-drive-pdf-rejection",
        workspaceId: "workspace-drive-pdf-rejection",
      },
    );
    expect(outcome).toEqual({
      ok: false,
      kind: "failed",
      message: "The file is not a valid PDF.",
    });
    const logs = JSON.stringify([infoSpy.mock.calls, warnSpy.mock.calls]);
    expect(logs).toContain("pdf_extraction");
    for (const marker of [privateMarker, "secret-access-token",
      "secret-pdf-id", "private-payroll.pdf"]) {
      expect(logs).not.toContain(marker);
      expect(JSON.stringify(outcome)).not.toContain(marker);
    }
  });

  it("does not return or log an unexpected executor exception", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const privateMarker = "PRIVATE EXECUTOR PARAMETER MARKER";
    const params = new Proxy(
      {},
      {
        get() {
          throw new Error(privateMarker);
        },
      },
    ) as Record<string, unknown>;

    const outcome = await executeOperation(
      findOperation("gmail.search")!,
      params,
      {
        taskId: "task-unexpected-executor",
        actionId: "action-unexpected-executor",
        workspaceId: "workspace-unexpected-executor",
      },
    );

    expect(outcome).toEqual({
      ok: false,
      kind: "failed",
      message: UNEXPECTED_APP_ERROR_MESSAGE,
    });
    expect(JSON.stringify(outcome)).not.toContain(privateMarker);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateMarker);
  });
});

/**
 * Small deterministic PDF fixture for the production executor path. The
 * transport passes these bytes to the shared isolated parser; no extractor
 * seam or checked-in document is involved.
 */
function pdfFixture(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
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

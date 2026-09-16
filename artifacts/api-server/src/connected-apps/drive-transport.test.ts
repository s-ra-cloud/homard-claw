import { describe, expect, it, vi } from "vitest";
import type { ExtractPdfTextOptions } from "../pdf/extract";
import {
  DEFAULT_DRIVE_READ_TIMEOUT_MS,
  MAX_DRIVE_READ_BODY_BYTES,
  classifyDriveReadHttpFailure,
  readDriveFileTransport,
} from "./drive-transport";

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A tiny deterministic PDF that is valid enough for PDF.js, but does not
 * depend on a checked-in document or a fixture generator. Keeping the bytes
 * here exercises the same isolated parser used by production Drive reads.
 */
function pdfFixture(text: string, padding = 0): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>${" ".repeat(padding)}`,
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

describe("readDriveFileTransport", () => {
  it.each(["application/pdf", "text/plain", "application/vnd.google-apps.document"])(
    "enforces the inclusive 25 MB boundary for %s with honest, missing and understated lengths",
    async (mimeType) => {
      expect(MAX_DRIVE_READ_BODY_BYTES).toBe(25_000_000);
      for (const length of [undefined, "1", "25000000", "25000001"]) {
        for (const size of [25_000_000, 25_000_001]) {
          let sent = 0;
          let cancelled = false;
          let calls = 0;
          const extractPdf = vi.fn(async (bytes: Uint8Array, options?: ExtractPdfTextOptions) => {
            expect(bytes.byteLength).toBe(25_000_000);
            expect(options).toMatchObject({ maxInputBytes: 25_000_000, pdfPages: "7-9" });
            return "Selected pages";
          });
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === size) { controller.close(); return; }
              const count = Math.min(64 * 1024, size - sent);
              controller.enqueue(new Uint8Array(count).fill(65));
              sent += count;
            },
            cancel() { cancelled = true; },
          }, { highWaterMark: 0 });
          const result = await readDriveFileTransport({
            workspaceId: "size-workspace", fileId: "private-file",
            pdfPages: mimeType === "application/pdf" ? "7-9" : undefined,
            resolveToken: async () => "token", extractPdf,
            fetchImpl: async () => ++calls === 1
              ? response(JSON.stringify({ mimeType }))
              : new Response(stream, { headers: length ? { "content-length": length } : {} }),
          });
          if (size > 25_000_000 || length === "25000001") {
            expect(result).toEqual({ ok: false, kind: "failed",
              message: "Google Drive returned a file larger than the 25 MB read limit." });
            expect(cancelled).toBe(true);
            expect(extractPdf).not.toHaveBeenCalled();
          } else {
            expect(result.ok).toBe(true);
            if (mimeType === "application/pdf") expect(extractPdf).toHaveBeenCalledTimes(1);
            else if (result.ok) expect(result.text.length).toBe(25_000_000);
          }
        }
      }
    },
  );

  it("retains the smaller metadata response allowance", async () => {
    const result = await readDriveFileTransport({
      workspaceId: "workspace", fileId: "file", resolveToken: async () => "token",
      fetchImpl: async () => response(" ".repeat(2 * 1024 * 1024 + 1)),
    });
    expect(result.ok).toBe(false);
  });

  it("forwards page selection with the original workspace and extraction bounds", async () => {
    const resolveToken = vi.fn(async (_workspaceId: string | null) => "token");
    const extractPdf = vi.fn(async (_bytes: Uint8Array, _options?: ExtractPdfTextOptions) => "selected text");
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "selected-workspace", fileId: "file", pdfPages: "7-9",
      resolveToken, extractPdf,
      fetchImpl: async () => ++calls === 1
        ? response(JSON.stringify({ mimeType: "application/pdf" }))
        : new Response("%PDF-1.7"),
    });
    expect(result.ok).toBe(true);
    expect(resolveToken.mock.calls[0]?.[0]).toBe("selected-workspace");
    expect(extractPdf.mock.calls[0]?.[1]).toMatchObject({
      pdfPages: "7-9", maxInputBytes: MAX_DRIVE_READ_BODY_BYTES,
      signal: expect.any(AbortSignal), deadlineAt: expect.any(Number),
    });
  });

  it("refuses page selection on non-PDFs without downloading", async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify({ mimeType: "text/plain" })));
    const result = await readDriveFileTransport({
      workspaceId: "workspace", fileId: "file", pdfPages: "2",
      resolveToken: async () => "token", fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("only supported for PDF") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["application/octet-stream", "image/png",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"])(
    "refuses %s before downloading binary content", async (mimeType) => {
      let calls = 0;
      const failures: unknown[] = [];
      const result = await readDriveFileTransport({
        workspaceId: "workspace-binary",
        fileId: "private-file",
        resolveToken: async () => "token",
        onFailure: (details) => failures.push(details),
        fetchImpl: async () => {
          calls++;
          return response(JSON.stringify({ name: "private-name", mimeType }));
        },
      });
      expect(calls).toBe(1);
      expect(result).toMatchObject({ ok: false, kind: "failed" });
      expect(JSON.stringify(result)).toContain("text extraction");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(failures).toEqual([{ stage: "metadata", failureClass: "unsupported_content" }]);
    },
  );

  it("downloads a PDF as bounded bytes and passes the shared signal into extraction", async () => {
    let calls = 0;
    let extractionInput:
      | {
          bytes: Uint8Array;
          options?: {
            signal?: AbortSignal;
            maxInputBytes?: number;
            deadlineAt?: number;
          };
        }
      | undefined;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-pdf",
      fileId: "pdf-file",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({
              name: "report.pdf",
              mimeType: "application/pdf",
            }))
          : new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      },
      // The production path always uses extractPdfText. This local seam
      // proves the Drive transport's byte/deadline/signal contract without
      // duplicating the shared parser's fixture suite here.
      extractPdf: async (bytes, options) => {
        extractionInput = { bytes, options };
        return "--- Page 1 ---\nPDF text";
      },
    });

    expect(result).toEqual({
      ok: true,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "--- Page 1 ---\nPDF text",
    });
    expect(calls).toBe(2);
    expect(extractionInput?.bytes).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(extractionInput?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(extractionInput?.options?.maxInputBytes).toBe(
      MAX_DRIVE_READ_BODY_BYTES,
    );
    expect(extractionInput?.options?.deadlineAt).toEqual(expect.any(Number));
  });

  it("extracts a deterministic PDF through the shared parser on the production path", async () => {
    const bytes = pdfFixture("Drive parser fixture", 3_000_000);
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-pdf-real",
      fileId: "pdf-real",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({
              name: "deterministic-report.pdf",
              mimeType: "application/pdf",
            }))
          : new Response(bytes);
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("deterministic-report.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(result.text).toContain(
        "--- Page 1 (text only; visual and image content omitted) ---",
      );
      expect(result.text).toContain("Drive parser fixture");
    }
    expect(calls).toBe(2);
  });

  it("keeps a real parser rejection content-free", async () => {
    const privateMarker = "PRIVATE DOCUMENT CONTENT MARKER";
    const failures: unknown[] = [];
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-pdf-private",
      fileId: "private-pdf-id",
      onFailure: (details) => failures.push(details),
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({
              name: "private-payroll.pdf",
              mimeType: "application/pdf",
            }))
          : new Response(`%PDF-${privateMarker}`);
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "The file is not a valid PDF.",
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(JSON.stringify(result)).not.toContain("private-payroll");
    expect(JSON.stringify(failures)).not.toContain(privateMarker);
    expect(failures).toEqual([
      { stage: "extract", failureClass: "pdf_extraction" },
    ]);
  });

  it("denies a read without a workspace before credentials, network, or extraction", async () => {
    let credentialCalls = 0;
    let fetchCalls = 0;
    let extractionCalls = 0;
    const result = await readDriveFileTransport({
      workspaceId: null,
      fileId: "tenant-private-pdf",
      resolveToken: async () => {
        credentialCalls += 1;
        return "must-not-resolve";
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(pdfFixture("must not be read"));
      },
      extractPdf: async () => {
        extractionCalls += 1;
        return "must not spawn";
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "auth",
      refusedBeforeExecution: true,
      message:
        "This task has no workspace owner, so no connected account can be used for it.",
    });
    expect(credentialCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(extractionCalls).toBe(0);
  });

  it("aborts an active PDF extractor through the same signal as Drive I/O", async () => {
    const controller = new AbortController();
    let extractorStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      extractorStarted = resolve;
    });
    let extractorSawAbort = false;
    let calls = 0;
    const resultPromise = readDriveFileTransport({
      workspaceId: "workspace-pdf-cancel",
      fileId: "pdf-cancel",
      signal: controller.signal,
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({ mimeType: "application/pdf" }))
          : new Response("%PDF-1.7");
      },
      extractPdf: async (_bytes, options) => {
        extractorStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              extractorSawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return "must not be returned after cancellation";
      },
    });

    await started;
    controller.abort();
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive read was cancelled.",
    });
    expect(extractorSawAbort).toBe(true);
  });

  it("does not invoke extraction after a PDF exceeds the 25 MB download limit", async () => {
    let calls = 0;
    let extractionCalled = false;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-pdf-limit",
      fileId: "pdf-limit",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({ mimeType: "application/pdf" }))
          : new Response("x".repeat(MAX_DRIVE_READ_BODY_BYTES + 1));
      },
      extractPdf: async () => {
        extractionCalled = true;
        return "not reached";
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "Google Drive returned a file larger than the 25 MB read limit.",
    });
    expect(extractionCalled).toBe(false);
  });

  it("turns an unexpected PDF extractor error into a content-free failure", async () => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-pdf-error",
      fileId: "private-pdf-id",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(JSON.stringify({
              name: "private-payroll.pdf",
              mimeType: "application/pdf",
            }))
          : new Response("%PDF-1.7");
      },
      extractPdf: async () => {
        throw new Error("private parser document details");
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "Google Drive could not extract readable text from this PDF.",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    new Uint8Array([65, 0, 66]),
    new Uint8Array([0xff, 0xfe, 65]),
    new TextEncoder().encode("%PDF-1.7 private binary"),
    new TextEncoder().encode("PK\u0003\u0004private binary"),
  ])("refuses binary bytes mislabeled as text without leaking the body", async (bytes) => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-text",
      fileId: "private-file",
      resolveToken: async () => "token",
      fetchImpl: async () => ++calls === 1
        ? response(JSON.stringify({ mimeType: "text/plain" }))
        : new Response(bytes),
    });
    expect(result).toMatchObject({ ok: false, kind: "failed" });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("\\u0000");
  });

  it("preserves valid Unicode text", async () => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-text",
      fileId: "unicode",
      resolveToken: async () => "token",
      fetchImpl: async () => ++calls === 1
        ? response(JSON.stringify({ mimeType: "text/plain", name: "Résumé" }))
        : new Response("Bonjour, résumé — 日本語"),
    });
    expect(result).toMatchObject({ ok: true, text: "Bonjour, résumé — 日本語" });
  });

  it("uses one credential and carries one signal through metadata and export", async () => {
    const calls: { url: string; authorization: string; signal?: AbortSignal }[] =
      [];
    const stages: string[] = [];
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "file-a",
      onStage: (stage) => stages.push(stage),
      resolveToken: async (workspaceId, options) => {
        expect(workspaceId).toBe("workspace-a");
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.deadlineAt).toBeGreaterThan(Date.now());
        return "token-a";
      },
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          authorization: headers.get("authorization") ?? "",
          signal: init?.signal ?? undefined,
        });
        return calls.length === 1
          ? response(
              JSON.stringify({
                id: "file-a",
                name: "safe-name.txt",
                mimeType: "application/vnd.google-apps.document",
              }),
            )
          : new Response("exported text");
      },
    });

    expect(result).toEqual({
      ok: true,
      name: "safe-name.txt",
      mimeType: "application/vnd.google-apps.document",
      text: "exported text",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe("Bearer token-a");
    expect(calls[1]?.authorization).toBe("Bearer token-a");
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    expect(stages).toEqual([
      "credentials",
      "metadata",
      "body",
      "export",
      "body",
    ]);
  });

  it("bounds a metadata request that ignores cancellation", async () => {
    let requestSignal: AbortSignal | undefined;
    const failures: unknown[] = [];
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "metadata-timeout",
      deadlineAt: Date.now() + 20,
      onFailure: (details) => failures.push(details),
      resolveToken: async () => "token",
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive read timed out before it completed.",
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(failures).toEqual([
      {
        stage: "metadata",
        failureClass: "timeout",
      },
    ]);
  });

  it("propagates caller cancellation to the active network request", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const resultPromise = readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "cancelled",
      signal: controller.signal,
      resolveToken: async () => "token",
      fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined;
        requestStarted();
        return new Promise<Response>(() => undefined);
      },
    });
    await started;
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive read was cancelled.",
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("bounds body consumption and aborts the active body reader", async () => {
    let readerCancelled = false;
    const hangingBodyResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise< never>(() => undefined),
          cancel: async () => {
            readerCancelled = true;
          },
        }),
      },
    } as unknown as Response;
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "body-timeout",
      deadlineAt: Date.now() + 20,
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(
              JSON.stringify({
                id: "body-timeout",
                name: "private-name.txt",
                mimeType: "text/plain",
              }),
            )
          : hangingBodyResponse;
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive read timed out before it completed.",
    });
    expect(readerCancelled).toBe(true);
  });

  it("bounds successful bodies and never returns an oversized payload", async () => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "oversized",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(
              JSON.stringify({
                id: "oversized",
                name: "private-name.txt",
                mimeType: "text/plain",
              }),
            )
          : new Response("x".repeat(MAX_DRIVE_READ_BODY_BYTES + 1));
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "failed",
      message: "Google Drive returned a file larger than the 25 MB read limit.",
    });
  });

  it("turns parser and body transport exceptions into safe outcomes", async () => {
    const parserFailure = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "secret-file-name",
      resolveToken: async () => "token",
      fetchImpl: async () => response("raw provider body: secret-file-name"),
    });
    expect(parserFailure).toEqual({
      ok: false,
      kind: "failed",
      message: "Google Drive returned invalid file metadata.",
    });
    expect(JSON.stringify(parserFailure)).not.toContain("secret-file-name");

    let calls = 0;
    const bodyFailure = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "secret-file-name",
      resolveToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return response(
            JSON.stringify({
              id: "secret-file-name",
              name: "secret-file-name",
              mimeType: "text/plain",
            }),
          );
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error("raw body secret-file-name");
              },
              cancel: async () => undefined,
            }),
          },
        } as unknown as Response;
      },
    });
    expect(bodyFailure).toEqual({
      ok: false,
      kind: "failed",
      message: "The Google Drive read could not be completed.",
    });
    expect(JSON.stringify(bodyFailure)).not.toContain("secret-file-name");
  });

  it("classifies permission, rate, and authorization refusals without bodies", () => {
    const permission = classifyDriveReadHttpFailure(
      403,
      new Headers({ "content-type": "application/json" }),
    );
    expect(permission.kind).toBe("failed");
    expect(permission.message).toContain("permission");

    const rate = classifyDriveReadHttpFailure(
      429,
      new Headers({ "x-provider-body": "sensitive provider text" }),
    );
    expect(rate.kind).toBe("failed");
    expect(rate.message).toContain("rate-limiting");
    expect(rate.message).not.toContain("sensitive provider text");

    const unauthorized = classifyDriveReadHttpFailure(401);
    const modernScope = classifyDriveReadHttpFailure(
      403,
      new Headers(),
      JSON.stringify({
        error: {
          status: "PERMISSION_DENIED",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "googleapis.com",
            reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
          }],
        },
      }),
    );
    expect(modernScope.kind).toBe("auth");
    expect(modernScope.refusedBeforeExecution).toBeUndefined();
    expect(unauthorized.kind).toBe("auth");
    expect(unauthorized.refusedBeforeExecution).toBeUndefined();
    expect(unauthorized.message).not.toContain("file");

    const reasonRate = classifyDriveReadHttpFailure(
      403,
      undefined,
      JSON.stringify({
        error: {
          errors: [{ reason: "userRateLimitExceeded" }],
        },
      }),
    );
    expect(reasonRate.message).toContain("rate-limiting");

    const reasonPermission = classifyDriveReadHttpFailure(
      403,
      undefined,
      JSON.stringify({
        error: {
          errors: [{ reason: "insufficientPermissions" }],
        },
      }),
    );
    expect(reasonPermission.kind).toBe("auth");
    expect(reasonPermission.refusedBeforeExecution).toBeUndefined();

    const ordinaryBody = classifyDriveReadHttpFailure(
      403,
      undefined,
      JSON.stringify({ error: { message: "a file named scope-notes" } }),
    );
    expect(ordinaryBody.kind).toBe("failed");
  });

  it("reports only safe failure class and provider status", async () => {
    const failures: unknown[] = [];
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "private-name",
      onFailure: (details) => failures.push(details),
      resolveToken: async () => "token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              errors: [
                {
                  reason: "insufficientPermissions",
                  message: "private-name should never be logged",
                },
              ],
            },
          }),
          { status: 403 },
        ),
    });

    expect(result.ok).toBe(false);
    expect(failures).toEqual([
      {
        stage: "metadata",
        failureClass: "permission",
        providerStatus: 403,
      },
    ]);
    expect(JSON.stringify(failures)).not.toContain("private-name");
  });

  it("classifies missing scopes safely before making a network request", async () => {
    let calls = 0;
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "scope-file",
      resolveToken: async () => {
        throw {
          kind: "reconnect_required",
          classification: "missing_scope",
          message: "scope details and secret-file-name",
        };
      },
      fetchImpl: async () => {
        calls += 1;
        return response("");
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "auth",
      refusedBeforeExecution: true,
      message:
        "The connected Google account is missing required Google Drive permissions. Reconnect Google Drive and try again.",
    });
    expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret-file-name");
  });

  it("does not flatten a revoked credential into a missing-scope message", async () => {
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "revoked-file",
      resolveToken: async () => {
        throw {
          kind: "reconnect_required",
          classification: "credential",
          message: "raw revoked credential details",
        };
      },
    });

    expect(result).toEqual({
      ok: false,
      kind: "auth",
      refusedBeforeExecution: true,
      message:
        "The connected Google account is no longer authorized. Reconnect Google Drive and try again.",
    });
    expect(JSON.stringify(result)).not.toContain("raw revoked");
  });

  it("keeps concurrent workspace reads isolated", async () => {
    const calls: { workspaceId: string; token: string }[] = [];
    const read = (workspaceId: string, fileId: string) =>
      readDriveFileTransport({
        workspaceId,
        fileId,
        resolveToken: async (id) => `token-for-${id}`,
        fetchImpl: async (_url, init) => {
          const token = new Headers(init?.headers).get("authorization") ?? "";
          calls.push({ workspaceId, token });
          return calls.filter((call) => call.workspaceId === workspaceId).length === 1
            ? response(
                JSON.stringify({
                  id: fileId,
                  name: `${workspaceId}.txt`,
                  mimeType: "text/plain",
                }),
              )
            : new Response(workspaceId);
        },
      });

    const [first, second] = await Promise.all([
      read("workspace-a", "file-a"),
      read("workspace-b", "file-b"),
    ]);
    expect(first.ok && first.text).toBe("workspace-a");
    expect(second.ok && second.text).toBe("workspace-b");
    expect(calls).toEqual(
      expect.arrayContaining([
        { workspaceId: "workspace-a", token: "Bearer token-for-workspace-a" },
        { workspaceId: "workspace-b", token: "Bearer token-for-workspace-b" },
      ]),
    );
  });

  it("uses the 30 second default when no earlier deadline is provided", async () => {
    let observedDeadline: number | undefined;
    const before = Date.now();
    const result = await readDriveFileTransport({
      workspaceId: "workspace-a",
      fileId: "file-a",
      resolveToken: async (_workspaceId, options) => {
        observedDeadline = options.deadlineAt;
        return "token";
      },
      fetchImpl: async (url) =>
        String(url).includes("/export")
          ? new Response("text")
          : response(
              JSON.stringify({
                id: "file-a",
                mimeType: "text/plain",
              }),
            ),
    });
    expect(result.ok).toBe(true);
    expect(observedDeadline).toBeGreaterThanOrEqual(
      before + DEFAULT_DRIVE_READ_TIMEOUT_MS - 100,
    );
    expect(observedDeadline).toBeLessThanOrEqual(
      before + DEFAULT_DRIVE_READ_TIMEOUT_MS + 100,
    );
  });
});
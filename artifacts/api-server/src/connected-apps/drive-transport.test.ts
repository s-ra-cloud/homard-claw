import { describe, expect, it } from "vitest";
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

describe("readDriveFileTransport", () => {
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
      message: "Google Drive returned a file larger than the read limit.",
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
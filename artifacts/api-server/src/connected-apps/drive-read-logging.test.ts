import { afterEach, describe, expect, it, vi } from "vitest";
import { executeOperation } from "./connections";
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
      async (): Promise<Response> => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(
              JSON.stringify({
                id: "secret-file-id",
                name: "private-file-name",
                mimeType: "text/plain",
              }),
            )
          : new Response("private file body");
      },
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
});
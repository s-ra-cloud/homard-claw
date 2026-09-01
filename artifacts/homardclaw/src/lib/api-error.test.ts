import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAgentMemory } from "@workspace/api-client-react";
import {
  apiErrorMessage,
  GATEWAY_ERROR_MESSAGE,
  NETWORK_ERROR_MESSAGE,
} from "./api-error";

/**
 * These tests drive the REAL generated client (`refreshAgentMemory` →
 * `customFetch`) against canned production-style responses, then feed the
 * exact error it throws into `apiErrorMessage` — the same path the Memory
 * page's "Update now" toast takes. A hand-built error object could drift
 * from the client's actual shape; this cannot.
 */

function stubResponse(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function captureRefreshError(): Promise<unknown> {
  try {
    await refreshAgentMemory("agent-1");
  } catch (error) {
    return error;
  }
  throw new Error("expected the refresh request to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiErrorMessage with the generated fetch client", () => {
  it("surfaces the API's busy-session message from a 503 JSON body", async () => {
    const busy =
      "The ChatGPT Codex session is busy with another run; retry in a moment.";
    const mock = stubResponse(
      new Response(JSON.stringify({ error: busy }), {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await captureRefreshError();
    expect(apiErrorMessage(error, "Try again.")).toBe(busy);
    // Production-style routing: the generated URL includes the /api prefix.
    expect(String(mock.mock.calls[0]![0])).toBe(
      "/api/agents/agent-1/memory/refresh",
    );
  });

  it("surfaces a 422 configuration message verbatim", async () => {
    const setup = "Codex is not enabled. Reconnect ChatGPT under Providers.";
    stubResponse(
      new Response(JSON.stringify({ error: setup }), {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(apiErrorMessage(await captureRefreshError(), "Try again.")).toBe(
      setup,
    );
  });

  it("surfaces a 429 allowance message verbatim", async () => {
    const allowance =
      "The ChatGPT plan allowance is used up; it resets on its own schedule.";
    stubResponse(
      new Response(JSON.stringify({ error: allowance }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(apiErrorMessage(await captureRefreshError(), "Try again.")).toBe(
      allowance,
    );
  });

  it("replaces a deployment proxy's HTML timeout page with a useful fallback", async () => {
    stubResponse(
      new Response("<html><body>Gateway Timeout</body></html>", {
        status: 504,
        statusText: "Gateway Timeout",
        headers: { "content-type": "text/html" },
      }),
    );
    const message = apiErrorMessage(await captureRefreshError(), "Try again.");
    expect(message).toBe(GATEWAY_ERROR_MESSAGE);
    expect(message).not.toContain("<html>");
  });

  it("names the HTTP status when a server error has no usable body", async () => {
    stubResponse(
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );
    const message = apiErrorMessage(await captureRefreshError(), "Try again.");
    expect(message).toContain("500");
    expect(message).toContain("Try again.");
  });

  it("gives a network failure (no HTTP response at all) a specific fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Exactly what browsers throw when the connection drops.
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(apiErrorMessage(await captureRefreshError(), "Try again.")).toBe(
      NETWORK_ERROR_MESSAGE,
    );
  });

  it("falls back to the caller's message for unrecognized errors", () => {
    expect(apiErrorMessage({ odd: true }, "Try again.")).toBe("Try again.");
    expect(apiErrorMessage(undefined, "Try again.")).toBe("Try again.");
  });

  it("still parses success and no-change bodies through the same client", async () => {
    stubResponse(
      new Response(
        JSON.stringify({
          agentId: "agent-1",
          agentName: "Groomer",
          status: "no_changes",
          added: 0,
          updated: 0,
          removed: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await refreshAgentMemory("agent-1");
    expect(result.status).toBe("no_changes");
    expect(result.added + result.updated + result.removed).toBe(0);
  });
});

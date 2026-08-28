/**
 * OpenRouter response handling.
 *
 * OpenRouter answers HTTP 200 for more than just success: structured error
 * bodies, choice-level mid-generation failures, token-exhausted empty
 * completions, and alternate content shapes all arrive with an OK status.
 * These tests pin down how each shape is classified — what is extracted,
 * what is retryable, and (critically) that no prompt text, credential, or
 * raw provider body ever reaches an error message, since those messages
 * flow into durable task records and the UI.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, workspacesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// All provider traffic is mocked; no test may reach the real vendor.
const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { getProviderAdapter, ProviderCallError } from "./execution";
import { saveProviderCredential } from "./provider-credentials";

const API_KEY = "or-test-key-abcdef123456";
const PROMPT = "Summarize the flamingo quarterly report";
let workspaceId = "";

beforeAll(async () => {
  const [ws] = await db
    .insert(workspacesTable)
    .values({ clerkUserId: `hc-or-adapter-${Date.now()}` })
    .returning({ id: workspacesTable.id });
  workspaceId = ws!.id;
  await saveProviderCredential(workspaceId, "openrouter", API_KEY);
});

afterAll(async () => {
  // Cascade removes the provider credential row for the throwaway workspace.
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  await pool.end();
});

beforeEach(() => {
  fetchMock.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockCompletion(body: unknown, status = 200) {
  fetchMock.mockImplementation(async () => jsonResponse(body, status));
}

async function execute() {
  return getProviderAdapter("openrouter").execute({
    workspaceId,
    provider: "openrouter",
    model: "test-vendor/test-model",
    system: "You are a test agent.",
    prompt: PROMPT,
    maxOutputTokens: 512,
    signal: new AbortController().signal,
  });
}

/** Run the adapter, assert it fails, and hand back the structured error. */
async function executeError(): Promise<ProviderCallError> {
  try {
    await execute();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCallError);
    return error as ProviderCallError;
  }
  throw new Error("expected the OpenRouter call to fail");
}

/** Durable error text must never echo the prompt, the key, or a body. */
function expectSanitized(error: ProviderCallError, rawBodyMarker?: string) {
  for (const text of [error.message, error.userMessage ?? ""]) {
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(API_KEY);
    if (rawBodyMarker) expect(text).not.toContain(rawBodyMarker);
  }
}

describe("successful completions", () => {
  it("extracts plain string content and records reported usage", async () => {
    mockCompletion({
      choices: [
        { message: { content: "The flamingos are thriving." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 321, completion_tokens: 45 },
    });
    const result = await execute();
    expect(result.output).toBe("The flamingos are thriving.");
    expect(result.inputTokens).toBe(321);
    expect(result.outputTokens).toBe(45);
    // The workspace's own key was presented, exactly once.
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("extracts text from array-of-parts content, ignoring non-text parts", async () => {
    mockCompletion({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "Part one." },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "text", text: "Part two." },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const result = await execute();
    expect(result.output).toBe("Part one.\nPart two.");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
  });

  it("defaults missing usage to zero rather than failing", async () => {
    mockCompletion({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    const result = await execute();
    expect(result.output).toBe("ok");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe("structured error bodies on HTTP 200", () => {
  it("maps a 429 error code to a retryable rate limit without quoting the body", async () => {
    mockCompletion({
      error: { code: 429, message: `rate limited while handling: ${PROMPT}` },
    });
    const error = await executeError();
    expect(error.kind).toBe("rate_limit");
    expect(error.retryable).toBe(true);
    expectSanitized(error, "rate limited while handling");
  });

  it("maps a 402 error code to a terminal allowance failure", async () => {
    mockCompletion({
      error: { code: 402, message: `balance-xyz-1234 too low for: ${PROMPT}` },
    });
    const error = await executeError();
    expect(error.kind).toBe("allowance");
    expect(error.retryable).toBe(false);
    expectSanitized(error, "balance-xyz-1234");
  });

  it("maps a 401 error code to an auth failure", async () => {
    mockCompletion({ error: { code: 401, message: `bad key ${API_KEY}` } });
    const error = await executeError();
    expect(error.kind).toBe("auth");
    expect(error.retryable).toBe(false);
    expectSanitized(error, "bad key");
  });

  it("maps a 5xx error code to a retryable transient failure", async () => {
    mockCompletion({ error: { code: 502, message: "upstream exploded" } });
    const error = await executeError();
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
    expectSanitized(error, "upstream exploded");
  });

  it("handles a non-numeric error code with a fixed provider_error", async () => {
    mockCompletion({
      error: { code: "moderation_blocked", message: `flagged input: ${PROMPT}` },
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("OpenRouter reported an error for this request.");
    expectSanitized(error, "moderation_blocked");
  });
});

describe("empty and non-completing responses", () => {
  it("treats a token-exhausted empty completion as retryable", async () => {
    mockCompletion({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 900, completion_tokens: 512 },
    });
    const error = await executeError();
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/token limit.*length/i);
    expectSanitized(error);
  });

  it("treats a null-content length completion (reasoning burn) as retryable", async () => {
    mockCompletion({
      choices: [{ message: { content: null }, finish_reason: "length" }],
    });
    const error = await executeError();
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
  });

  it("fails terminally when the content filter withheld the reply", async () => {
    mockCompletion({
      choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("content_filter");
    expectSanitized(error);
  });

  it("fails terminally when the model answered with a tool call", async () => {
    mockCompletion({
      choices: [
        {
          message: { content: null, tool_calls: [{ id: "call_1" }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("tool_calls");
  });

  it("reports reasoning-only output without quoting the reasoning text", async () => {
    mockCompletion({
      choices: [
        {
          message: { content: "", reasoning: "secret chain of thought about flamingos" },
          finish_reason: "stop",
        },
      ],
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/only reasoning output/i);
    expectSanitized(error, "secret chain of thought");
  });

  it("fails terminally on a genuinely textless stop completion", async () => {
    mockCompletion({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("no text output");
    expect(error.message).toContain("stop");
  });

  it("reduces an undocumented finish reason to 'unknown' before persisting", async () => {
    const weird = `provider-detail: ${PROMPT}`;
    mockCompletion({
      choices: [{ message: { content: "" }, finish_reason: weird }],
    });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.message).toContain("unknown");
    expectSanitized(error, "provider-detail");
  });

  it("retries a choice-level mid-generation provider error", async () => {
    mockCompletion({
      choices: [
        {
          message: { content: "" },
          finish_reason: "error",
          error: { code: 502, message: `upstream died mid-stream on: ${PROMPT}` },
        },
      ],
    });
    const error = await executeError();
    expect(error.kind).toBe("transient");
    expect(error.retryable).toBe(true);
    expectSanitized(error, "upstream died");
  });

  it("fails clearly when the response has no choices at all", async () => {
    mockCompletion({ usage: { prompt_tokens: 10, completion_tokens: 0 } });
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.message).toContain("no completion choices");
  });

  it("fails clearly on a malformed (non-JSON) body", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const error = await executeError();
    expect(error.kind).toBe("provider_error");
    expect(error.message).toBe("OpenRouter returned a malformed response.");
    expectSanitized(error, "gateway error");
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "./sanitize";

const hadEnv = "OPENROUTER_API_KEY" in process.env;
const priorEnv = process.env.OPENROUTER_API_KEY;

afterAll(() => {
  if (hadEnv) process.env.OPENROUTER_API_KEY = priorEnv;
  else delete process.env.OPENROUTER_API_KEY;
});

describe("sanitizeErrorMessage", () => {
  it("redacts Authorization header material", () => {
    const out = sanitizeErrorMessage(
      'fetch failed: upstream said "Authorization: Bearer abc123def456ghi789" was invalid',
    );
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).toContain("[redacted]");
  });

  it("redacts common API key shapes", () => {
    const out = sanitizeErrorMessage(
      "request with key sk-or-v1-0123456789abcdef0123456789abcdef was rejected",
    );
    expect(out).not.toContain("sk-or-v1-0123456789abcdef");
    expect(out).toContain("[redacted]");
  });

  it("redacts key=value credential assignments while keeping the key name", () => {
    const out = sanitizeErrorMessage(
      "config error: api_key=supersecretvalue123 not accepted",
    );
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("api_key=");
  });

  it("redacts credentials embedded in connection URLs", () => {
    const out = sanitizeErrorMessage(
      "could not connect to postgres://admin:hunter2pass@db.internal:5432/app",
    );
    expect(out).not.toContain("hunter2pass");
  });

  it("redacts literal values of known secret env vars", () => {
    process.env.OPENROUTER_API_KEY = "test-literal-secret-value-42";
    const out = sanitizeErrorMessage(
      "provider said: bad credential test-literal-secret-value-42 supplied",
    );
    expect(out).not.toContain("test-literal-secret-value-42");
    expect(out).toContain("[redacted]");
  });

  it("redacts quoted JSON header values including the token after Bearer", () => {
    const out = sanitizeErrorMessage(
      'upstream rejected {"Authorization": "Bearer tok_0123456789abcdef"} payload',
    );
    expect(out).not.toContain("tok_0123456789abcdef");
  });

  it("redacts camel-case apiKey JSON fields", () => {
    const out = sanitizeErrorMessage(
      'bad request body: {"apiKey": "super-secret-key-value-1"}',
    );
    expect(out).not.toContain("super-secret-key-value-1");
    expect(out).toContain("[redacted]");
  });

  it("clips very long messages", () => {
    const out = sanitizeErrorMessage("x".repeat(2000));
    expect(out.length).toBeLessThanOrEqual(501);
  });

  it("leaves ordinary messages readable", () => {
    const msg = "The provider returned HTTP 502.";
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });
});

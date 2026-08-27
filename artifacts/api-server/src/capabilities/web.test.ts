import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeNativeWebHandler,
  fetchReadablePage,
  isPublicWebAddress,
} from "./web";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("native web address policy", () => {
  it("allows public addresses and rejects private, loopback, link-local, CGNAT, and ULA ranges", () => {
    expect(isPublicWebAddress("8.8.8.8")).toBe(true);
    expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicWebAddress(address), address).toBe(false);
    }
  });

  it("refuses plain HTTP targets before DNS or network access", async () => {
    const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const requestOnce = vi.fn();
    await expect(
      fetchReadablePage(
        "http://169.254.169.254/latest/meta-data",
        { timeoutMs: 1000 },
        { resolve, requestOnce },
      ),
    ).rejects.toThrow();
    await expect(
      fetchReadablePage(
        "http://localhost:5432/",
        { timeoutMs: 1000 },
        { resolve, requestOnce },
      ),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers without exposing or contacting them", async () => {
    const requestOnce = vi.fn();
    let failure: unknown;
    try {
      await fetchReadablePage(
        "https://internal.example/",
        { timeoutMs: 1000 },
        {
          resolve: async () => [{ address: "10.20.30.40", family: 4 }],
          requestOnce,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("10.20.30.40");
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it("re-resolves and refuses a redirect from a public page to a private host", async () => {
    const resolve = vi.fn(async (hostname: string) =>
      hostname === "public.example"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "10.0.0.9", family: 4 as const }],
    );
    const requestOnce = vi.fn(async () => ({
      status: 302,
      location: "https://private.example/admin",
      contentType: "text/html",
      body: Buffer.alloc(0),
    }));
    await expect(
      fetchReadablePage(
        "https://public.example/start",
        { timeoutMs: 1000 },
        { resolve, requestOnce },
      ),
    ).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(requestOnce).toHaveBeenCalledTimes(1);
  });

  it("caps redirects at three and shares the original timeout budget", async () => {
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);
    const requestOnce = vi.fn(async (_target, options) => {
      expect(options.timeoutMs).toBeLessThanOrEqual(1000);
      expect(options.maxBytes).toBe(2 * 1024 * 1024);
      return {
        status: 302,
        location: "https://public.example/next",
        contentType: "text/html",
        body: Buffer.alloc(0),
      };
    });
    await expect(
      fetchReadablePage(
        "https://public.example/start",
        { timeoutMs: 1000 },
        { resolve, requestOnce },
      ),
    ).rejects.toThrow();
    expect(requestOnce).toHaveBeenCalledTimes(4);
  });

  it("includes DNS resolution in the configured timeout", async () => {
    await expect(
      fetchReadablePage(
        "https://slow.example/",
        { timeoutMs: 5 },
        {
          resolve: async () => new Promise(() => undefined),
          requestOnce: vi.fn(),
        },
      ),
    ).rejects.toThrow();
  });

  it("turns HTML into readable text and strips scripts and controls", async () => {
    const text = await fetchReadablePage(
      "https://public.example/article",
      { timeoutMs: 1000 },
      {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        requestOnce: async () => ({
          status: 200,
          location: null,
          contentType: "text/html; charset=utf-8",
          body: Buffer.from(
            "<main><h1>Kelp &amp; Tide</h1><p>Useful\u0007 facts.</p><script>steal()</script></main>",
          ),
        }),
      },
    );
    expect(text).toContain("Kelp & Tide");
    expect(text).toContain("Useful facts.");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("\u0007");
  });
});

describe("native web handler", () => {
  it("reports a clear configuration failure and performs no network request", async () => {
    vi.stubEnv("WEB_SEARCH_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const search = await executeNativeWebHandler(
      "web.search",
      { query: "kelp" },
      { timeoutMs: 1000, charLimit: 1000 },
    );
    const page = await executeNativeWebHandler(
      "web.fetch",
      { url: "https://example.com" },
      { timeoutMs: 1000, charLimit: 1000 },
    );
    expect(search).toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringMatching(/not configured/i),
      }),
    );
    expect(page).toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringMatching(/not configured/i),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches through the fixed HTTPS API and returns sanitized HTTPS results", async () => {
    vi.stubEnv("WEB_SEARCH_API_KEY", "test-search-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "<b>Kelp</b> report",
                url: "https://example.com/kelp",
                description: "Facts\u0007 <i>from the sea</i>",
              },
              {
                title: "Plain HTTP is excluded",
                url: "http://example.com/unsafe",
                description: "No fallback",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await executeNativeWebHandler(
      "web.search",
      { query: "kelp" },
      { timeoutMs: 1000, charLimit: 2000 },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Kelp report");
    expect(outcome.text).toContain("https://example.com/kelp");
    expect(outcome.text).not.toContain("http://example.com/unsafe");
    expect(outcome.text).not.toContain("\u0007");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.search.brave.com");
    expect(
      (init.headers as Record<string, string>)["x-subscription-token"],
    ).toBe("test-search-secret");
    expect(init.redirect).toBe("error");
  });

  it("returns a sanitized refusal for metadata and localhost HTTP URLs", async () => {
    vi.stubEnv("WEB_SEARCH_API_KEY", "test-search-secret");
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://localhost:5432/",
    ]) {
      const outcome = await executeNativeWebHandler(
        "web.fetch",
        { url },
        { timeoutMs: 1000, charLimit: 1000 },
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.message).toMatch(/refused|public https/i);
      expect(outcome.message).not.toContain("169.254.169.254");
      expect(outcome.message).not.toContain("localhost");
    }
  });
});

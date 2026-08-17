/**
 * The SDK is the first thing a developer meets, and it is the piece that
 * decides whether the error contract shipped in P3 is any use in practice.
 * These cover the parts with judgement in them: what becomes a GifiError,
 * what gets retried, and whether a retry can double-charge.
 */
import { describe, expect, it, vi } from "vitest";
import { GifiClient, GifiError } from "./index.js";

const PROBLEM = {
  type: "https://gifi.ai/docs#error-insufficient_credits",
  title: "Insufficient credits",
  status: 402,
  detail: "Not enough credits",
  code: "insufficient_credits",
  hint: "Top up or upgrade at /pricing, then retry.",
  retryable: false,
  error: "Not enough credits",
};

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function response(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new GifiClient({ apiKey: "wmr_test_key", fetch: fetchImpl, maxRetries });
}

describe("authentication", () => {
  it("refuses to construct without a key rather than failing at the first call", () => {
    expect(() => new GifiClient({ apiKey: "" })).toThrow(/apiKey is required/);
  });

  it("sends the key as a bearer token", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response({ ok: true }));
    await client(fetchImpl as unknown as typeof fetch).usage();
    const init = fetchImpl.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer wmr_test_key");
  });
});

describe("errors", () => {
  it("turns a problem document into a typed error, hint included", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response(PROBLEM, { status: 402 }));
    await expect(client(fetchImpl as unknown as typeof fetch).usage()).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
      retryable: false,
      hint: "Top up or upgrade at /pricing, then retry.",
    });
  });

  it("reports a refund so the caller knows a failed job cost nothing", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () =>
      response({ ...PROBLEM, code: "processing_failed", status: 422, retryable: false, refunded: true }, { status: 422 }),
    );
    const err = await client(fetchImpl as unknown as typeof fetch)
      .usage()
      .catch((e) => e as GifiError);
    expect(err).toBeInstanceOf(GifiError);
    expect((err as GifiError).refunded).toBe(true);
  });

  it("still produces a typed error when the body is not a problem document", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => new Response("<html>gateway</html>", { status: 502 }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch).usage()).rejects.toMatchObject({
      status: 502,
      code: "internal_error",
    });
  });
});

describe("retries", () => {
  it("retries only what the server marked retryable", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response(PROBLEM, { status: 402 }));
    await expect(client(fetchImpl as unknown as typeof fetch).usage()).rejects.toThrow();
    // A 402 will never become a 200 by asking again.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable failure and returns the eventual success", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<FetchMock>(async () => {
      calls += 1;
      if (calls === 1) {
        return response(
          { ...PROBLEM, code: "service_unavailable", status: 503, retryable: true },
          { status: 503, headers: { "retry-after": "0" } },
        );
      }
      return response({ plan: { id: "pro" } });
    });
    const result = await client(fetchImpl as unknown as typeof fetch).usage();
    expect(calls).toBe(2);
    expect(result.data).toMatchObject({ plan: { id: "pro" } });
  });

  it("gives up after maxRetries instead of hammering", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () =>
      response({ ...PROBLEM, code: "rate_limited", status: 429, retryable: true }, {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );
    await expect(client(fetchImpl as unknown as typeof fetch, 1).usage()).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("billed calls", () => {
  it("sends an Idempotency-Key so a retry cannot charge twice", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response({ kind: "text", text: "clean" }));
    await client(fetchImpl as unknown as typeof fetch).clean({ text: "hi" });
    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeTruthy();
  });

  it("honours a caller's own key", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response({ kind: "text" }));
    await client(fetchImpl as unknown as typeof fetch).clean({ text: "hi" }, { idempotencyKey: "mine-1" });
    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("mine-1");
  });

  it("reports a replayed response rather than hiding it", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () =>
      response({ kind: "file" }, { headers: { "idempotency-replayed": "true" } }),
    );
    const result = await client(fetchImpl as unknown as typeof fetch).clean({ text: "hi" });
    expect(result.replayed).toBe(true);
  });

  it("base64-encodes file bytes for the caller", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response({ kind: "file" }));
    await client(fetchImpl as unknown as typeof fetch).clean({
      file: new Uint8Array([104, 105]),
      filename: "a.txt",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).toEqual({ file: "aGk=", filename: "a.txt" });
  });
});

describe("rate limits and paging", () => {
  it("surfaces the window so a caller can pace itself", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () =>
      response(
        { plan: {} },
        { headers: { "ratelimit-limit": "120", "ratelimit-remaining": "118", "ratelimit-reset": "43" } },
      ),
    );
    const result = await client(fetchImpl as unknown as typeof fetch).usage();
    expect(result.rateLimit).toEqual({ limit: 120, remaining: 118, resetSeconds: 43 });
  });

  it("follows the cursor to the end and stops", async () => {
    const pages = [
      { data: [{ id: "a" }], pagination: { limit: 1, hasMore: true, nextCursor: "c1" } },
      { data: [{ id: "b" }], pagination: { limit: 1, hasMore: false, nextCursor: null } },
    ];
    let call = 0;
    const fetchImpl = vi.fn<FetchMock>(async () => response(pages[call++]));
    const seen: string[] = [];
    for await (const job of client(fetchImpl as unknown as typeof fetch).jobs({ limit: 1 })) {
      seen.push(job.id);
    }
    expect(seen).toEqual(["a", "b"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

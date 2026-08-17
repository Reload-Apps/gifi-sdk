/**
 * Official TypeScript client for the Gifi API.
 *
 * Written against the published contract at https://gifi.ai/openapi.json, and
 * deliberately dependency-free: an SDK that drags a tree of transitive
 * packages into an agent's runtime is a liability for what amounts to six
 * HTTP calls.
 */

export const GIFI_BASE_URL = "https://gifi.ai";

/** Stable identifiers from https://gifi.ai/docs#errors. Branch on these. */
export type GifiErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "insufficient_credits"
  | "insufficient_scope"
  | "subscription_required"
  | "not_found"
  | "unsupported_format"
  | "payload_too_large"
  | "processing_failed"
  | "idempotency_in_flight"
  | "idempotency_key_reused"
  | "rate_limited"
  | "internal_error"
  | "not_configured"
  | "service_unavailable";

/** RFC 9457 problem document, as the API returns it. */
export interface GifiProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: GifiErrorCode;
  hint: string;
  retryable: boolean;
  refunded?: boolean;
  error: string;
}

/**
 * A failure carrying the machine-readable half of the problem document.
 *
 * `retryable` comes from the server rather than being inferred from the status:
 * a 402 and a 429 are both "no" today, but only one of them will ever change
 * by waiting, and the server is the thing that knows which.
 */
export class GifiError extends Error {
  readonly code: GifiErrorCode;
  readonly status: number;
  readonly hint: string;
  readonly retryable: boolean;
  readonly refunded: boolean;
  readonly retryAfterSeconds?: number;
  readonly problem?: GifiProblem;

  constructor(
    message: string,
    init: {
      code: GifiErrorCode;
      status: number;
      hint?: string;
      retryable?: boolean;
      refunded?: boolean;
      retryAfterSeconds?: number;
      problem?: GifiProblem;
    },
  ) {
    super(message);
    this.name = "GifiError";
    this.code = init.code;
    this.status = init.status;
    this.hint = init.hint ?? "";
    this.retryable = init.retryable ?? false;
    this.refunded = init.refunded ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.problem = init.problem;
  }
}

/** Where the caller stands in the current rate-limit window. */
export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  resetSeconds: number | null;
}

export interface GifiResponse<T> {
  data: T;
  rateLimit: RateLimitSnapshot;
  /** True when the API replayed a stored response for a repeated Idempotency-Key. */
  replayed: boolean;
}

export interface GifiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Automatic retries for failures the server marked retryable. Waits for
   * Retry-After when the server sent one. Default 2.
   */
  maxRetries?: number;
}

export type EmDash = "keep" | "hyphen" | "spaced-hyphen" | "comma";
export type RewriteStrength = "paraphrase" | "humanize" | "code" | "backtranslate" | "structural";

export interface InspectTextInput {
  text: string;
  aggressive?: boolean;
}
export interface FileInput {
  /** Raw bytes, or base64. Bytes are encoded for you. */
  file: Uint8Array | string;
  filename: string;
}
export interface CleanTextInput {
  text: string;
  options?: {
    nfkc?: boolean;
    punctuation?: boolean;
    confusables?: boolean;
    emDash?: EmDash;
  };
}
export interface RewriteInput {
  text: string;
  strength?: RewriteStrength;
  candidates?: number;
  lang?: string;
}

export interface JobSummary {
  id: string;
  kind: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  source: string;
  filename: string | null;
  creditsCost: number;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface JobPage {
  data: JobSummary[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

export interface Usage {
  plan: { id: string; name: string; monthlyCredits: number };
  credits: { granted: number; purchased: number; total: number };
  rateLimit: { requestsPerMinute: number };
  last30Days: { requests: number; creditsUsed: number; byEndpoint: Record<string, number> };
}

function toBase64(input: Uint8Array | string): string {
  if (typeof input === "string") return input;
  if (typeof Buffer !== "undefined") return Buffer.from(input).toString("base64");
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function header(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function newIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `gifi-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GifiClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;

  constructor(options: GifiClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required. Create one at https://gifi.ai/api-keys");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? GIFI_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  /** Inspect text or a file. Free, and changes nothing. */
  async inspect(input: InspectTextInput | FileInput): Promise<GifiResponse<Record<string, unknown>>> {
    return this.#send("POST", "/api/v1/inspect", this.#payload(input));
  }

  /**
   * Clean text (free) or strip a file (one credit).
   *
   * An Idempotency-Key is generated when you do not supply one, so a retry
   * after a dropped connection replays the first response rather than
   * cleaning — and charging for — the same file twice.
   */
  async clean(
    input: CleanTextInput | FileInput,
    options?: { idempotencyKey?: string },
  ): Promise<GifiResponse<Record<string, unknown>>> {
    return this.#send("POST", "/api/v1/clean", this.#payload(input), {
      "idempotency-key": options?.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  /** Rewrite text. One credit per candidate, three by default. */
  async rewrite(
    input: RewriteInput,
    options?: { idempotencyKey?: string },
  ): Promise<GifiResponse<Record<string, unknown>>> {
    return this.#send("POST", "/api/v1/rewrite", input as unknown as Record<string, unknown>, {
      "idempotency-key": options?.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  /** Credit balance, plan limits and the last 30 days. Free. */
  async usage(): Promise<GifiResponse<Usage>> {
    return this.#send<Usage>("GET", "/api/v1/usage");
  }

  /** One page of jobs, newest first. */
  async listJobs(params?: { limit?: number; cursor?: string }): Promise<GifiResponse<JobPage>> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.cursor) query.set("cursor", params.cursor);
    const suffix = query.toString();
    return this.#send<JobPage>("GET", `/api/v1/jobs${suffix ? `?${suffix}` : ""}`);
  }

  /** Every job, following the cursor for you. */
  async *jobs(params?: { limit?: number }): AsyncGenerator<JobSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.listJobs({ limit: params?.limit, cursor });
      for (const job of page.data.data) yield job;
      cursor = page.data.pagination.nextCursor ?? undefined;
    } while (cursor);
  }

  /** Status and result of one job. */
  async getJob(id: string): Promise<GifiResponse<Record<string, unknown>>> {
    return this.#send("GET", `/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  #payload(input: object): Record<string, unknown> {
    if ("file" in input) {
      const { file, filename } = input as FileInput;
      return { file: toBase64(file), filename };
    }
    return input as Record<string, unknown>;
  }

  async #send<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<GifiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let lastError: GifiError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const rateLimit: RateLimitSnapshot = {
        limit: header(response, "ratelimit-limit"),
        remaining: header(response, "ratelimit-remaining"),
        resetSeconds: header(response, "ratelimit-reset"),
      };

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (response.ok) {
        return {
          data: parsed as T,
          rateLimit,
          replayed: response.headers.get("idempotency-replayed") === "true",
        };
      }

      const problem = (parsed ?? {}) as Partial<GifiProblem>;
      const retryAfter = header(response, "retry-after");
      lastError = new GifiError(problem.detail ?? problem.error ?? `Request failed (${response.status})`, {
        code: (problem.code as GifiErrorCode) ?? "internal_error",
        status: response.status,
        hint: problem.hint,
        retryable: problem.retryable ?? false,
        refunded: problem.refunded ?? false,
        retryAfterSeconds: retryAfter ?? undefined,
        problem: problem.code ? (problem as GifiProblem) : undefined,
      });

      // Only the server's own verdict earns a retry — guessing from the status
      // is how a client ends up hammering an endpoint that will never succeed.
      if (!lastError.retryable || attempt === this.#maxRetries) break;

      const waitSeconds = lastError.retryAfterSeconds ?? Math.min(2 ** attempt, 8);
      await sleep(waitSeconds * 1000);
    }

    throw lastError;
  }
}

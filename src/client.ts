/**
 * The HTTP core: auth, retries, idempotency, timeouts, errors.
 *
 * Built on `fetch` and nothing else, so the same build runs on Node 18+, in a
 * browser, on Cloudflare Workers, Deno and Bun. An SDK that pulls in an HTTP
 * library is an SDK that cannot be used at the edge, and the edge is where a
 * lot of this gets called from.
 *
 * Three behaviours here are the reason to use this rather than `fetch`
 * directly, and each one is a mistake that is easy to make by hand:
 *
 * **Idempotency keys are automatic.** Every mutating request gets one unless
 * you supply your own. Without it a retry — ours or yours — can charge a
 * customer twice or create a second bot. The key is generated once per logical
 * call and reused across that call's retries, which is the part people get
 * wrong: a key generated inside the retry loop is a different key each time
 * and buys nothing.
 *
 * **Retries respect the server.** A 429 carries `Retry-After`, and honouring it
 * is strictly better than any backoff curve invented here — the server knows
 * when the window resets and the client is guessing. Backoff is used only when
 * there is no header, and it is jittered, because synchronised retries from
 * many clients are how a recovering service is knocked over again.
 *
 * **Only safe things are retried.** A POST with no idempotency key is never
 * retried, because "did that land?" is exactly the question retrying cannot
 * answer safely.
 */

import {
  ConnectionError,
  IntegrableError,
  TimeoutError,
  errorFromResponse,
  type ApiErrorBody,
} from "./errors.js";

export interface ClientOptions {
  /** Your `sk_live_` key. Create one at Settings → API keys. */
  apiKey: string;
  /** Override for self-hosted or staging. Defaults to production. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 60_000. */
  timeout?: number;
  /**
   * How many times to retry a failed request. Default 2 (so up to 3 attempts).
   * Set 0 to disable and handle retries yourself.
   */
  maxRetries?: number;
  /** Extra headers on every request. */
  defaultHeaders?: Record<string, string>;
  /** Swap in a custom fetch — for tests, proxies, or an instrumented client. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  /** Query parameters. `undefined` values are dropped rather than sent empty. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Override the automatic idempotency key for this call. */
  idempotencyKey?: string;
  /** Per-call timeout override, in milliseconds. */
  timeout?: number;
  /** Per-call retry override. */
  maxRetries?: number;
  /** Additional headers for this call. */
  headers?: Record<string, string>;
  /** Cancel the request from outside. */
  signal?: AbortSignal;
}

/** What the rate limiter said on the last response. */
export interface RateLimit {
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  reset: number;
}

/** A response, with the metadata worth surfacing alongside the body. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  requestId: string | undefined;
  /** The dated API version that served this, e.g. `2026-09-03`. */
  apiVersion: string | undefined;
  rateLimit: RateLimit | undefined;
  /** True when the API replayed a stored response for your idempotency key. */
  replayed: boolean;
  /** Set when this API version has a removal date. Log it. */
  sunset: string | undefined;
}

const DEFAULT_BASE_URL = "https://api.integrable.cloud";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Crypto-quality where available, adequate everywhere. */
function idempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ConnectionError("Request aborted"));
      },
      { once: true },
    );
  });
}

function readRateLimit(headers: Headers): RateLimit | undefined {
  const limit = headers.get("ratelimit-limit");
  if (!limit) return undefined;
  return {
    limit: Number(limit),
    remaining: Number(headers.get("ratelimit-remaining") ?? 0),
    reset: Number(headers.get("ratelimit-reset") ?? 0),
  };
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** The rate-limit state from the most recent response, if any. */
  lastRateLimit: RateLimit | undefined;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error(
        "An API key is required. Create one at Settings → API keys, then pass it " +
          "as `new Integrable({ apiKey })`.",
      );
    }
    if (!options.apiKey.startsWith("sk_")) {
      throw new Error(
        "That does not look like an Integrable API key — they start with `sk_live_`. " +
          "A dashboard session token will not work here.",
      );
    }

    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "No global fetch found. Use Node 18 or later, or pass one as `{ fetch }`.",
      );
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    // Generated once, outside the retry loop, so every attempt of this logical
    // call carries the same key. That is the whole mechanism.
    if (MUTATING.has(method.toUpperCase())) {
      headers["idempotency-key"] = options.idempotencyKey ?? idempotencyKey();
    }

    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeout = options.timeout ?? this.timeout;
    let lastError: IntegrableError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const rateLimit = readRateLimit(response.headers);
        if (rateLimit) this.lastRateLimit = rateLimit;

        if (response.ok) {
          const text = await response.text();
          return {
            data: (text ? JSON.parse(text) : undefined) as T,
            status: response.status,
            requestId: response.headers.get("x-request-id") ?? undefined,
            apiVersion: response.headers.get("x-api-version") ?? undefined,
            rateLimit,
            replayed: response.headers.get("idempotent-replay") === "true",
            sunset: response.headers.get("sunset") ?? undefined,
          };
        }

        let parsed: ApiErrorBody | undefined;
        try {
          parsed = JSON.parse(await response.text()) as ApiErrorBody;
        } catch {
          parsed = undefined;
        }
        lastError = errorFromResponse(response.status, parsed, response.headers, attempt);
      } catch (cause) {
        if (options.signal?.aborted) throw new ConnectionError("Request aborted", cause);
        lastError =
          cause instanceof Error && cause.name === "AbortError"
            ? new TimeoutError(`Request timed out after ${timeout}ms`)
            : new ConnectionError(
                cause instanceof Error ? cause.message : "Network request failed",
                cause,
              );
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }

      const isLast = attempt === maxRetries + 1;
      if (isLast || !lastError.retryable) break;

      // A mutating call with no idempotency key must never be retried: we
      // cannot tell a lost response from a request that never arrived, and
      // guessing wrong charges someone twice.
      if (MUTATING.has(method.toUpperCase()) && !headers["idempotency-key"]) break;

      await sleep(this.backoff(attempt, lastError), options.signal);
    }

    throw lastError ?? new ConnectionError("Request failed for an unknown reason");
  }

  /**
   * How long to wait before the next attempt.
   *
   * `Retry-After` wins whenever the server sent one: it knows when the window
   * resets and we are guessing. Otherwise exponential with full jitter —
   * `random(0, base * 2^n)` rather than `base * 2^n` — because unjittered
   * backoff synchronises every client that failed at the same moment into
   * retrying at the same moment, which is how a service that was recovering
   * gets knocked over a second time.
   */
  private backoff(attempt: number, error: IntegrableError): number {
    const retryAfter = error.headers?.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    }
    const ceiling = Math.min(500 * 2 ** (attempt - 1), 8_000);
    return Math.random() * ceiling;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, body, options);
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>("PATCH", path, body, options);
  }
  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>("DELETE", path, undefined, options);
  }
}

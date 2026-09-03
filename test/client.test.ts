/**
 * The behaviour that makes this worth using instead of `fetch`.
 *
 * All of it runs against a stub `fetch`, so the suite is offline and fast. The
 * things being proven are the ones that are invisible until they matter: that
 * a retry reuses the *same* idempotency key, that a POST without one is never
 * retried, and that `Retry-After` beats the backoff curve.
 */

import { describe, expect, it, vi } from "vitest";

import { Integrable } from "../src/index.js";
import {
  AuthenticationError,
  ConflictError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "../src/errors.js";

/**
 * A typed stand-in for `fetch`.
 *
 * `vi.fn(async () => ...)` infers an empty argument tuple, so every
 * `mock.calls[0][1]` below is a type error even though the test runs fine —
 * vitest transpiles without typechecking, so this only shows up under `tsc`.
 * Declaring the signature once fixes all of them and makes the assertions
 * read better.
 */
type FetchArgs = Parameters<typeof globalThis.fetch>;
type FetchStub = ReturnType<typeof vi.fn<(...args: FetchArgs) => Promise<Response>>>;

function stubFetch(impl: () => Promise<Response>): FetchStub {
  return vi.fn(impl as (...args: FetchArgs) => Promise<Response>);
}

/** The headers sent on the nth call. */
function headersOf(stub: FetchStub, n = 0): Record<string, string> {
  return (stub.mock.calls[n]?.[1]?.headers ?? {}) as Record<string, string>;
}

const KEY = "sk_live_test_key";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(fetchImpl: typeof globalThis.fetch, overrides = {}) {
  return new Integrable({ apiKey: KEY, fetch: fetchImpl, maxRetries: 2, ...overrides });
}

describe("construction", () => {
  it("refuses an empty key with an actionable message", () => {
    expect(() => new Integrable({ apiKey: "" })).toThrow(/API key is required/);
  });

  it("refuses a session token, which is the mistake people actually make", () => {
    expect(() => new Integrable({ apiKey: "eyJhbGciOiJIUzI1NiJ9.abc" })).toThrow(
      /start with `sk_live_`/,
    );
  });
});

describe("authentication", () => {
  it("sends the key as a bearer token", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200, { items: [] }));
    await clientWith(fetchImpl).bots.list();

    expect(headersOf(fetchImpl)).toMatchObject({
      authorization: `Bearer ${KEY}`,
    });
  });
});

describe("idempotency", () => {
  it("adds a key to every mutation", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(201, { id: "b1" }));
    await clientWith(fetchImpl).bots.create({ name: "x" } as never);

    const headers = headersOf(fetchImpl);
    expect(headers["idempotency-key"]).toBeTruthy();
  });

  it("does not add one to a read", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(200, { items: [] }));
    await clientWith(fetchImpl).bots.list();

    const headers = headersOf(fetchImpl);
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("reuses the SAME key across retries of one call", async () => {
    // The detail everybody gets wrong. A key generated inside the retry loop
    // is a different key each time, so the server sees three unrelated
    // requests and creates three bots — precisely what the header prevents.
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503, { detail: "upstream" }) : jsonResponse(201, { id: "b1" });
    });

    await clientWith(fetchImpl).bots.create({ name: "x" } as never);

    const keys = fetchImpl.mock.calls.map((_, i) => headersOf(fetchImpl, i)["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("honours a caller-supplied key", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(201, { id: "b1" }));
    await clientWith(fetchImpl).bots.create({ name: "x" } as never, {
      idempotencyKey: "my-own-key",
    });

    const headers = headersOf(fetchImpl);
    expect(headers["idempotency-key"]).toBe("my-own-key");
  });

  it("reports a replay so a caller can tell it apart from a fresh create", async () => {
    const fetchImpl = stubFetch(async () =>
      jsonResponse(201, { id: "b1" }, { "idempotent-replay": "true" }),
    );
    const client = clientWith(fetchImpl);
    const response = await client.http.post("/api/bots", { name: "x" });
    expect(response.replayed).toBe(true);
  });
});

describe("retries", () => {
  it("retries a 5xx and succeeds", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(500, { detail: "boom" }) : jsonResponse(200, { items: [] });
    });

    await clientWith(fetchImpl).bots.list();
    expect(calls).toBe(2);
  });

  it("does not retry a 4xx that will never succeed", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(404, { detail: "Bot not found" }));
    await expect(clientWith(fetchImpl).bots.get("nope")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and reports how many attempts it made", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(503, { detail: "still down" }));
    const error = await clientWith(fetchImpl)
      .bots.list()
      .catch((e) => e);

    expect(error).toBeInstanceOf(ServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + maxRetries
    expect(error.attempts).toBe(3);
  });

  it("obeys Retry-After rather than its own backoff", async () => {
    // The server knows when the window resets; the client is guessing.
    let calls = 0;
    const fetchImpl = stubFetch(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { detail: "slow down" }, { "retry-after": "0" })
        : jsonResponse(200, { items: [] });
    });

    const started = Date.now();
    await clientWith(fetchImpl).bots.list();
    // `retry-after: 0` means retry immediately; an unjittered curve would have
    // slept ~500ms here.
    expect(Date.now() - started).toBeLessThan(400);
    expect(calls).toBe(2);
  });

  it("can be turned off", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse(500, { detail: "boom" }));
    await expect(
      clientWith(fetchImpl, { maxRetries: 0 }).bots.list(),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  const cases: [number, unknown, new (...a: never[]) => Error][] = [
    [401, { error: { code: "unauthorized" } }, AuthenticationError],
    [402, { error: { code: "quota_exceeded" } }, QuotaExceededError],
    [422, { error: { code: "validation_error" } }, ValidationError],
    [429, { error: { code: "rate_limited" } }, RateLimitError],
    [409, { error: { code: "conflict" } }, ConflictError],
  ];

  for (const [status, body, Expected] of cases) {
    it(`maps ${status} to ${Expected.name}`, async () => {
      const fetchImpl = stubFetch(async () => jsonResponse(status, body));
      const error = await clientWith(fetchImpl, { maxRetries: 0 })
        .bots.list()
        .catch((e) => e);
      expect(error).toBeInstanceOf(Expected);
    });
  }

  it("prefers the API's own message over a generic one", async () => {
    const fetchImpl = stubFetch(async () =>
      jsonResponse(422, {
        error: { code: "validation_error", message: "name must not be empty" },
        detail: "name must not be empty",
      }),
    );
    const error = await clientWith(fetchImpl)
      .bots.create({} as never)
      .catch((e) => e);

    expect(error.message).toBe("name must not be empty");
    expect(error.code).toBe("validation_error");
  });

  it("surfaces the request id for a support ticket", async () => {
    const fetchImpl = stubFetch(async () =>
      jsonResponse(404, { error: { code: "not_found", request_id: "req_abc123" } }),
    );
    const error = await clientWith(fetchImpl)
      .bots.get("x")
      .catch((e) => e);
    expect(error.requestId).toBe("req_abc123");
  });

  it("treats an in-progress idempotent request as retryable, unlike other conflicts", async () => {
    const inProgress = new ConflictError("in progress", {
      status: 409,
      body: { error: { code: "idempotency_in_progress" } },
    });
    const plain = new ConflictError("name taken", {
      status: 409,
      body: { error: { code: "conflict" } },
    });
    expect(inProgress.retryable).toBe(true);
    expect(plain.retryable).toBe(false);
  });
});

describe("rate limit", () => {
  it("exposes the budget from the last response", async () => {
    const fetchImpl = stubFetch(async () =>
      jsonResponse(
        200,
        { items: [] },
        {
          "ratelimit-limit": "120",
          "ratelimit-remaining": "7",
          "ratelimit-reset": "42",
        },
      ),
    );
    const client = clientWith(fetchImpl);
    await client.bots.list();
    expect(client.rateLimit).toEqual({ limit: 120, remaining: 7, reset: 42 });
  });
});

describe("pagination", () => {
  it("follows the cursor to the end", async () => {
    const pages = [
      { items: [{ id: "1" }, { id: "2" }], next_cursor: "c1", has_more: true },
      { items: [{ id: "3" }], next_cursor: null, has_more: false },
    ];
    let call = 0;
    const fetchImpl = stubFetch(async () => jsonResponse(200, pages[call++]!));

    const seen: string[] = [];
    for await (const bot of clientWith(fetchImpl).bots.walk()) {
      seen.push((bot as { id: string }).id);
    }
    expect(seen).toEqual(["1", "2", "3"]);
  });

  it("stops rather than looping forever when a cursor repeats", async () => {
    // A server bug that would otherwise be an infinite loop hammering the API.
    const fetchImpl = stubFetch(async () =>
      jsonResponse(200, { items: [{ id: "1" }], next_cursor: "same", has_more: true }),
    );
    const seen: unknown[] = [];
    for await (const item of clientWith(fetchImpl).bots.walk()) seen.push(item);
    expect(seen.length).toBe(2);
  });

  it("refuses to buffer an unbounded set in .all()", async () => {
    const fetchImpl = stubFetch(async () =>
      jsonResponse(200, { items: [{ id: "x" }], next_cursor: crypto.randomUUID(), has_more: true }),
    );
    await expect(clientWith(fetchImpl).bots.walk().all(5)).rejects.toThrow(
      /Refusing to buffer/,
    );
  });
});

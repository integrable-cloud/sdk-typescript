# @integrable-cloud/sdk

Official TypeScript SDK for the [Integrable Cloud](https://integrable.cloud) API — website chat assistants, conversations, knowledge bases and analytics.

```bash
npm install @integrable-cloud/sdk
```

Node 18+, and it runs unchanged in browsers, Cloudflare Workers, Deno and Bun. Built on `fetch` and nothing else.

## Quick start

```ts
import { Integrable } from "@integrable-cloud/sdk";

const client = new Integrable({ apiKey: process.env.INTEGRABLE_API_KEY! });

const { items } = await client.bots.list();
for (const bot of items) {
  console.log(bot.id, bot.name, bot.status);
}
```

Create a key in the dashboard under **Settings → API keys**. It starts with `sk_live_` and is shown once.

## What it does that `fetch` does not

**Retries safely.** Transient failures — 429, 5xx, connection resets — are retried with jittered exponential backoff. A `Retry-After` header always wins over the backoff curve, because the server knows when the window resets and the client is guessing.

**Idempotency keys, automatically.** Every mutating request carries one. Critically, a retry reuses the *same* key, so a create that timed out and was retried produces one bot rather than three. Supply your own when you need it:

```ts
await client.bots.create(body, { idempotencyKey: myStableId });
```

A mutating request without a key is never retried — "did that land?" is exactly the question retrying cannot answer safely.

**Pagination that stays fast.** List endpoints return a cursor, and `walk()` follows it lazily:

```ts
for await (const conversation of client.conversations.walk(botId, { days: 30 })) {
  await syncToCrm(conversation);
}
```

Never increment a page number against this API. Offset pagination makes the database read and discard every skipped row, so page 40 costs forty times page 1.

**Errors you can branch on.**

```ts
import { RateLimitError, QuotaExceededError, ValidationError } from "@integrable-cloud/sdk";

try {
  await client.knowledge.addText(botId, "Hours", "Open 9–5, Mon–Fri.");
} catch (error) {
  if (error instanceof QuotaExceededError) {
    console.error("Plan limit reached:", error.details);
  } else if (error instanceof ValidationError) {
    console.error("Bad request:", error.message, error.details);
  } else if (error instanceof RateLimitError) {
    console.error(`Retry in ${error.retryAfter}s`);
  } else {
    throw error;
  }
}
```

Every error carries `.requestId` — quote it at support and the exact call can be found.

**Rate-limit visibility.**

```ts
await client.bots.list();
console.log(client.rateLimit); // { limit: 120, remaining: 118, reset: 41 }
```

## Configuration

```ts
const client = new Integrable({
  apiKey: process.env.INTEGRABLE_API_KEY!,
  baseUrl: "https://api.integrable.cloud", // override for staging
  timeout: 60_000,                          // per request, ms
  maxRetries: 2,                            // 0 disables
  defaultHeaders: { "x-app": "my-service" },
  fetch: myInstrumentedFetch,               // for tests or a proxy
});
```

## Reaching an endpoint with no wrapper

The typed resources cover the common calls. All 149 endpoints are reachable through the HTTP client, and the full schema types are exported:

```ts
import type { components } from "@integrable-cloud/sdk";

type Contact = components["schemas"]["ContactRead"];

const { data } = await client.http.get<{ items: Contact[] }>(
  `/api/bots/${botId}/contacts`,
  { query: { limit: 50 } },
);
```

## Also available over MCP

If you want to *ask* about your workspace rather than write code against it, the same API key connects it to Claude, ChatGPT or your editor over the Model Context Protocol — see [the MCP guide](https://integrable.cloud/docs/mcp).

## Development

```bash
npm install
npm run generate    # regenerate types from openapi.json
npm run typecheck
npm test
npm run build
```

`src/generated/schema.ts` is produced from `openapi.json`, which is copied from the API. Never edit either by hand — CI regenerates and fails on a diff.

## Releasing

Bump `version` in `package.json`, commit, then tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow verifies the tag matches `package.json`, runs the full gate, and publishes with npm provenance.

## Links

- [Documentation](https://integrable.cloud/docs)
- [API reference](https://integrable.cloud/docs/api)
- [Python SDK](https://github.com/integrable-cloud/sdk-python)

MIT © Integrable Cloud

/**
 * Official TypeScript SDK for the Integrable Cloud API.
 *
 *     import { Integrable } from "@integrable-cloud/sdk";
 *
 *     const client = new Integrable({ apiKey: process.env.INTEGRABLE_API_KEY! });
 *     const { items } = await client.bots.list();
 *
 * Everything is generated from the same OpenAPI document that produces the
 * reference at integrable.cloud/docs/api and the Python SDK, so the three
 * cannot describe different APIs.
 */

import { HttpClient, type ClientOptions } from "./client.js";
import { Analytics, Bots, Conversations, Knowledge, Webhooks } from "./resources.js";

export class Integrable {
  /** The underlying HTTP client. Use it to reach an endpoint with no wrapper. */
  readonly http: HttpClient;

  readonly bots: Bots;
  readonly conversations: Conversations;
  readonly knowledge: Knowledge;
  readonly analytics: Analytics;
  readonly webhooks: Webhooks;

  constructor(options: ClientOptions) {
    this.http = new HttpClient(options);
    this.bots = new Bots(this.http);
    this.conversations = new Conversations(this.http);
    this.knowledge = new Knowledge(this.http);
    this.analytics = new Analytics(this.http);
    this.webhooks = new Webhooks(this.http);
  }

  /**
   * What the rate limiter said on the most recent response.
   *
   * Read it between calls in a batch job and slow down before you are blocked,
   * rather than after — the client retries a 429 for you, but not being
   * limited at all is faster than being limited and recovering.
   */
  get rateLimit() {
    return this.http.lastRateLimit;
  }
}

// Deliberately no default export. Mixing a default with named exports means
// a CommonJS consumer has to write `require("...").default`, which is a
// papercut nobody expects and every one of them hits once. Named only.

export { HttpClient } from "./client.js";
export type {
  ApiResponse,
  ClientOptions,
  RateLimit,
  RequestOptions,
} from "./client.js";

export { Paginator } from "./pagination.js";
export type { Page } from "./pagination.js";

export {
  Analytics,
  Bots,
  Conversations,
  Knowledge,
  Webhooks,
} from "./resources.js";
export type {
  Bot,
  BotCreate,
  BotUpdate,
  Document,
  DocumentCreate,
  ListParams,
  Webhook,
} from "./resources.js";

export {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  IntegrableError,
  NotFoundError,
  PermissionError,
  PreconditionRequiredError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
export type { ApiErrorBody } from "./errors.js";

/** Every schema in the API, for advanced use. */
export type { components, paths, operations } from "./generated/schema.js";

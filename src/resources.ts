/**
 * Typed wrappers over the endpoints people actually reach for.
 *
 * Deliberately not one method per route. The generated types cover all 149
 * paths and `client.request()` reaches any of them; what is hand-written here
 * is the fifteen or so calls that make up almost every integration, given
 * argument names and return types worth reading in an editor.
 *
 * Where the API returns a page, the wrapper returns a `Paginator` rather than
 * the first page — see `pagination.ts` for why following the cursor is the
 * only correct way to walk these.
 */

import type { HttpClient, RequestOptions } from "./client.js";
import { Paginator, type Page } from "./pagination.js";
import type { components } from "./generated/schema.js";

type Schemas = components["schemas"];

export type Bot = Schemas["BotRead"];
export type BotCreate = Schemas["BotCreate"];
export type BotUpdate = Schemas["BotUpdate"];
export type Document = Schemas["DocumentRead"];
export type DocumentCreate = Schemas["DocumentCreate"];
export type Webhook = Schemas["WebhookResponse"];
export type WebhookCreated = Schemas["WebhookCreated"];

export interface ListParams {
  limit?: number;
  cursor?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Assistants: create, configure, publish, retire. */
export class Bots {
  constructor(private readonly http: HttpClient) {}

  /** One page of assistants. Use `walk()` to iterate all of them. */
  async list(params: ListParams = {}) {
    const { data } = await this.http.get<Page<Bot>>("/api/bots", { query: params });
    return data;
  }

  /** Every assistant, fetched a page at a time as you consume it. */
  walk(params: ListParams = {}): Paginator<Bot> {
    return new Paginator<Bot>(async (cursor) => {
      const { data } = await this.http.get<Page<Bot>>("/api/bots", {
        query: { ...params, cursor },
      });
      return data;
    });
  }

  async get(botId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Bot>(`/api/bots/${botId}`, options);
    return data;
  }

  async create(body: BotCreate, options?: RequestOptions) {
    const { data } = await this.http.post<Bot>("/api/bots", body, options);
    return data;
  }

  async update(botId: string, body: BotUpdate, options?: RequestOptions) {
    const { data } = await this.http.patch<Bot>(`/api/bots/${botId}`, body, options);
    return data;
  }

  async delete(botId: string, options?: RequestOptions) {
    await this.http.delete(`/api/bots/${botId}`, options);
  }

  /** The embed snippet to paste into a site, with its integrity hash. */
  async embed(botId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/bots/${botId}/embed`,
      options,
    );
    return data;
  }
}

/** Conversations and their transcripts. */
export class Conversations {
  constructor(private readonly http: HttpClient) {}

  async list(botId: string, params: ListParams = {}) {
    const { data } = await this.http.get<Page<Record<string, unknown>>>(
      `/api/bots/${botId}/conversations`,
      { query: params },
    );
    return data;
  }

  /**
   * Every conversation matching the filters, oldest page first.
   *
   * The one to use for an export or a sync — it follows the cursor, so it stays
   * correct and fast on a workspace with a hundred thousand of them.
   */
  walk(botId: string, params: ListParams = {}): Paginator<Record<string, unknown>> {
    return new Paginator(async (cursor) => {
      const { data } = await this.http.get<Page<Record<string, unknown>>>(
        `/api/bots/${botId}/conversations`,
        { query: { ...params, cursor } },
      );
      return data;
    });
  }

  async get(botId: string, conversationId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/bots/${botId}/conversations/${conversationId}`,
      options,
    );
    return data;
  }
}

/** The knowledge base an assistant answers from. */
export class Knowledge {
  constructor(private readonly http: HttpClient) {}

  async list(botId: string, params: ListParams = {}) {
    const { data } = await this.http.get<Page<Document>>(`/api/bots/${botId}/knowledge`, {
      query: params,
    });
    return data;
  }

  walk(botId: string, params: ListParams = {}): Paginator<Document> {
    return new Paginator<Document>(async (cursor) => {
      const { data } = await this.http.get<Page<Document>>(
        `/api/bots/${botId}/knowledge`,
        { query: { ...params, cursor } },
      );
      return data;
    });
  }

  /**
   * Teach an assistant something.
   *
   * `source_type` decides which other fields apply: `raw_text` takes
   * `raw_text`, while `url` and `sitemap` take `url` and fetch it themselves.
   * Indexing is asynchronous — poll `status()` until it reports `ready`.
   */
  async create(botId: string, body: DocumentCreate, options?: RequestOptions) {
    const { data } = await this.http.post<Document>(
      `/api/bots/${botId}/knowledge`,
      body,
      options,
    );
    return data;
  }

  /** Add plain text, the common case, without assembling the discriminator. */
  async addText(
    botId: string,
    title: string,
    text: string,
    options?: RequestOptions,
  ): Promise<Document> {
    return this.create(
      botId,
      { source_type: "raw_text", title, raw_text: text } as DocumentCreate,
      options,
    );
  }

  async status(botId: string, documentId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/bots/${botId}/knowledge/${documentId}/status`,
      options,
    );
    return data;
  }

  async delete(botId: string, documentId: string, options?: RequestOptions) {
    await this.http.delete(`/api/bots/${botId}/knowledge/${documentId}`, options);
  }
}

/** Outcomes, volume and topics. */
export class Analytics {
  constructor(private readonly http: HttpClient) {}

  async forBot(botId: string, params: { days?: number } = {}, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/bots/${botId}/analytics`,
      { ...options, query: params },
    );
    return data;
  }

  /** The gaps report: questions the assistant could not answer well. */
  async gaps(botId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/bots/${botId}/analytics/gaps`,
      options,
    );
    return data;
  }
}

/** Event subscriptions and their delivery log. */
export class Webhooks {
  constructor(private readonly http: HttpClient) {}

  /** The event catalogue, each with a sample payload. */
  async events(options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>[]>(
      "/api/webhooks/events",
      options,
    );
    return data;
  }

  async list(options?: RequestOptions) {
    const { data } = await this.http.get<Page<Webhook>>("/api/webhooks", options);
    return data;
  }

  async create(
    body: { url: string; events: string[]; description?: string; bot_id?: string },
    options?: RequestOptions,
  ) {
    // `WebhookCreated`, not `WebhookResponse`: the create response is the
    // one and only time the signing secret is returned.
    const { data } = await this.http.post<WebhookCreated>("/api/webhooks", body, options);
    return data;
  }

  async delete(webhookId: string, options?: RequestOptions) {
    await this.http.delete(`/api/webhooks/${webhookId}`, options);
  }

  /** Fires a sample payload down the real delivery path, signing included. */
  async test(webhookId: string, options?: RequestOptions) {
    const { data } = await this.http.post<Record<string, unknown>>(
      `/api/webhooks/${webhookId}/test`,
      undefined,
      options,
    );
    return data;
  }

  /** Rotates the signing secret. The new one is returned exactly once. */
  async rotateSecret(webhookId: string, options?: RequestOptions) {
    const { data } = await this.http.post<Record<string, unknown>>(
      `/api/webhooks/${webhookId}/rotate-secret`,
      undefined,
      options,
    );
    return data;
  }

  async deliveries(params: ListParams = {}) {
    const { data } = await this.http.get<Page<Record<string, unknown>>>(
      "/api/webhooks/deliveries",
      { query: params },
    );
    return data;
  }

  /** Replays a delivery. Writes a new record rather than overwriting the old. */
  async replay(deliveryId: string, options?: RequestOptions) {
    const { data } = await this.http.post<Record<string, unknown>>(
      `/api/webhooks/deliveries/${deliveryId}/replay`,
      undefined,
      options,
    );
    return data;
  }
}

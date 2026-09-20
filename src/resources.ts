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

export type Agent = Schemas["AgentRead"];
export type AgentCreate = Schemas["AgentCreate"];
export type AgentUpdate = Schemas["AgentUpdate"];
export type Document = Schemas["DocumentRead"];
export type DocumentCreate = Schemas["DocumentCreate"];
export type Webhook = Schemas["WebhookResponse"];
export type WebhookCreated = Schemas["WebhookCreated"];

export interface ListParams {
  limit?: number;
  cursor?: string;
  [key: string]: string | number | boolean | undefined;
}

/** Agents: create, configure, publish, retire. */
export class Agents {
  constructor(private readonly http: HttpClient) {}

  /** One page of agents. Use `walk()` to iterate all of them. */
  async list(params: ListParams = {}) {
    const { data } = await this.http.get<Page<Agent>>("/api/agents", { query: params });
    return data;
  }

  /** Every agent, fetched a page at a time as you consume it. */
  walk(params: ListParams = {}): Paginator<Agent> {
    return new Paginator<Agent>(async (cursor) => {
      const { data } = await this.http.get<Page<Agent>>("/api/agents", {
        query: { ...params, cursor },
      });
      return data;
    });
  }

  async get(agentId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Agent>(`/api/agents/${agentId}`, options);
    return data;
  }

  async create(body: AgentCreate, options?: RequestOptions) {
    const { data } = await this.http.post<Agent>("/api/agents", body, options);
    return data;
  }

  async update(agentId: string, body: AgentUpdate, options?: RequestOptions) {
    const { data } = await this.http.patch<Agent>(`/api/agents/${agentId}`, body, options);
    return data;
  }

  async delete(agentId: string, options?: RequestOptions) {
    await this.http.delete(`/api/agents/${agentId}`, options);
  }

  /** The embed snippet to paste into a site, with its integrity hash. */
  async embed(agentId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/agents/${agentId}/embed`,
      options,
    );
    return data;
  }
}

/** Conversations and their transcripts. */
export class Conversations {
  constructor(private readonly http: HttpClient) {}

  async list(agentId: string, params: ListParams = {}) {
    const { data } = await this.http.get<Page<Record<string, unknown>>>(
      `/api/agents/${agentId}/conversations`,
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
  walk(agentId: string, params: ListParams = {}): Paginator<Record<string, unknown>> {
    return new Paginator(async (cursor) => {
      const { data } = await this.http.get<Page<Record<string, unknown>>>(
        `/api/agents/${agentId}/conversations`,
        { query: { ...params, cursor } },
      );
      return data;
    });
  }

  async get(agentId: string, conversationId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/agents/${agentId}/conversations/${conversationId}`,
      options,
    );
    return data;
  }
}

/** The knowledge base an agent answers from. */
export class Knowledge {
  constructor(private readonly http: HttpClient) {}

  async list(agentId: string, params: ListParams = {}) {
    const { data } = await this.http.get<Page<Document>>(`/api/agents/${agentId}/knowledge`, {
      query: params,
    });
    return data;
  }

  walk(agentId: string, params: ListParams = {}): Paginator<Document> {
    return new Paginator<Document>(async (cursor) => {
      const { data } = await this.http.get<Page<Document>>(
        `/api/agents/${agentId}/knowledge`,
        { query: { ...params, cursor } },
      );
      return data;
    });
  }

  /**
   * Teach an agent something.
   *
   * `source_type` decides which other fields apply: `raw_text` takes
   * `raw_text`, while `url` and `sitemap` take `url` and fetch it themselves.
   * Indexing is asynchronous — poll `status()` until it reports `ready`.
   */
  async create(agentId: string, body: DocumentCreate, options?: RequestOptions) {
    const { data } = await this.http.post<Document>(
      `/api/agents/${agentId}/knowledge`,
      body,
      options,
    );
    return data;
  }

  /** Add plain text, the common case, without assembling the discriminator. */
  async addText(
    agentId: string,
    title: string,
    text: string,
    options?: RequestOptions,
  ): Promise<Document> {
    return this.create(
      agentId,
      { source_type: "raw_text", title, raw_text: text } as DocumentCreate,
      options,
    );
  }

  async status(agentId: string, documentId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/agents/${agentId}/knowledge/${documentId}/status`,
      options,
    );
    return data;
  }

  async delete(agentId: string, documentId: string, options?: RequestOptions) {
    await this.http.delete(`/api/agents/${agentId}/knowledge/${documentId}`, options);
  }
}

/** Outcomes, volume and topics. */
export class Analytics {
  constructor(private readonly http: HttpClient) {}

  async forAgent(agentId: string, params: { days?: number } = {}, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/agents/${agentId}/analytics`,
      { ...options, query: params },
    );
    return data;
  }

  /** The gaps report: questions the agent could not answer well. */
  async gaps(agentId: string, options?: RequestOptions) {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/api/agents/${agentId}/analytics/gaps`,
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
    body: { url: string; events: string[]; description?: string; agent_id?: string },
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

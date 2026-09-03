/**
 * The error taxonomy, mapped from what the API actually sends.
 *
 * Every failure body carries two envelopes at once: a nested `error` object,
 * and the RFC 9457 members (`type`, `title`, `status`, `detail`, `instance`).
 * This reads both, because either can be the more specific one depending on
 * where the failure came from — a route's own `ValidationError` fills `error`
 * richly, while a gateway between us and you may only manage the RFC members.
 *
 * A distinct class per condition rather than one class with a status code,
 * because the interesting question in a `catch` is almost never "what number"
 * but "can I retry this, and if not, whose fault is it". `instanceof` answers
 * that; `if (e.status === 429)` makes every caller re-derive it.
 */

/** Shape of the body the API returns on a failure. Both envelopes are optional. */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: Record<string, unknown>;
  };
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
}

export interface ApiErrorOptions {
  status: number;
  body?: ApiErrorBody;
  headers?: Headers;
  /** How many attempts were made in total, including the one that failed. */
  attempts?: number;
}

/** Base class for everything this SDK throws. */
export class IntegrableError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  /** Machine-readable code, e.g. `not_found`, `idempotency_key_reused`. */
  readonly code: string | undefined;
  /** Quote this in a support request — it identifies the exact call. */
  readonly requestId: string | undefined;
  /** Structured detail, where the endpoint provides it. */
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Headers | undefined;
  readonly attempts: number;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.body?.error?.code;
    this.requestId =
      options.body?.error?.request_id ?? options.headers?.get("x-request-id") ?? undefined;
    this.details = options.body?.error?.details;
    this.headers = options.headers;
    this.attempts = options.attempts ?? 1;

    // Without this, `instanceof` fails for subclasses when the package is
    // compiled to ES5 by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Whether retrying this exact request could plausibly succeed.
   *
   * The client already retries these automatically; this is exposed for a
   * caller doing its own queueing on top.
   */
  get retryable(): boolean {
    return false;
  }
}

/** The request never reached the API: DNS, TLS, connection reset, offline. */
export class ConnectionError extends IntegrableError {
  constructor(message: string, cause?: unknown) {
    super(message, { status: 0 });
    this.cause = cause;
  }
  override get retryable(): boolean {
    return true;
  }
}

/** The request exceeded the configured timeout. */
export class TimeoutError extends IntegrableError {
  constructor(message: string) {
    super(message, { status: 0 });
  }
  override get retryable(): boolean {
    return true;
  }
}

/** 401 — the key is missing, malformed, expired or revoked. */
export class AuthenticationError extends IntegrableError {}

/** 403 — authenticated, but the key's scopes do not permit this. */
export class PermissionError extends IntegrableError {}

/** 404 — no such resource, or it belongs to another workspace. */
export class NotFoundError extends IntegrableError {}

/**
 * 409 — including an `Idempotency-Key` whose original request is still running.
 * Retryable after a short wait: the original may still complete.
 */
export class ConflictError extends IntegrableError {
  override get retryable(): boolean {
    return this.code === "idempotency_in_progress";
  }
}

/** 422 — the request body failed validation. `details` says which fields. */
export class ValidationError extends IntegrableError {}

/** 402 — a plan limit was reached. `details` carries the metric and the limit. */
export class QuotaExceededError extends IntegrableError {}

/** 428 — a precondition is unmet, e.g. the account's email is unconfirmed. */
export class PreconditionRequiredError extends IntegrableError {}

/** 429 — rate limited. `retryAfter` is seconds, from the response header. */
export class RateLimitError extends IntegrableError {
  get retryAfter(): number | undefined {
    const header = this.headers?.get("retry-after");
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  override get retryable(): boolean {
    return true;
  }
}

/** 5xx — something failed on our side. */
export class ServerError extends IntegrableError {
  override get retryable(): boolean {
    return true;
  }
}

const BY_STATUS: Record<number, typeof IntegrableError> = {
  401: AuthenticationError,
  402: QuotaExceededError,
  403: PermissionError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  428: PreconditionRequiredError,
  429: RateLimitError,
};

/**
 * Builds the right error class from a response.
 *
 * The message prefers the API's own `detail`/`message` over anything invented
 * here, because those are written for the person reading the stack trace — a
 * generic "Request failed with status 422" replaces a sentence that said
 * exactly which field was wrong.
 */
export function errorFromResponse(
  status: number,
  body: ApiErrorBody | undefined,
  headers: Headers,
  attempts: number,
): IntegrableError {
  const Cls = BY_STATUS[status] ?? (status >= 500 ? ServerError : IntegrableError);
  const message =
    body?.error?.message ??
    body?.detail ??
    body?.title ??
    `Request failed with status ${status}`;
  return new Cls(message, { status, body, headers, attempts });
}

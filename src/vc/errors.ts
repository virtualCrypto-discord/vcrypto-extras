/**
 * A refusal from virtualCrypto.
 *
 * Only `error` / `error_info` and the status are contractual — the service says
 * so in as many words in its own documentation — so those are what this keeps
 * and what a caller branches on. `error_description` is carried along for the
 * log, and nothing should decide anything by it.
 */

export class VcApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly errorInfo: string | null;
  readonly description: string | null;
  /** Set when the service said to come back — a `429` or a `409 processing`. */
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    status: number;
    error: string;
    errorInfo?: string | null;
    description?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(
      `virtualCrypto answered ${input.status} ${input.error}` +
        (input.errorInfo ? ` (${input.errorInfo})` : ""),
    );
    this.name = "VcApiError";
    this.status = input.status;
    this.error = input.error;
    this.errorInfo = input.errorInfo ?? null;
    this.description = input.description ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

/** Build the error from a refusal the client is about to throw. */
export async function vcErrorFrom(response: Response): Promise<VcApiError> {
  let error = "unknown";
  let errorInfo: string | null = null;
  let description: string | null = null;

  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_info?: unknown;
      error_description?: unknown;
    };
    if (typeof body.error === "string") error = body.error;
    if (typeof body.error_info === "string") errorInfo = body.error_info;
    if (typeof body.error_description === "string")
      description = body.error_description;
  } catch {
    // A refusal whose body is not the JSON it promises is still a refusal.
  }

  return new VcApiError({
    status: response.status,
    error,
    errorInfo,
    description,
    retryAfterSeconds: retryAfterSeconds(response),
  });
}

/** The `Retry-After` header, in seconds, when it is a whole number. */
export function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

/** RFC 8628's "not yet" on the device poll: the same code, asked again later. */
export function isAuthorizationPending(error: VcApiError): boolean {
  return error.error === "authorization_pending";
}

/** Callers branch on `error_info` where the service sets it; this keeps that one spelling. */
export function isVcApiError(
  value: unknown,
  errorInfo?: string,
): value is VcApiError {
  return (
    value instanceof VcApiError &&
    (errorInfo === undefined || value.errorInfo === errorInfo)
  );
}

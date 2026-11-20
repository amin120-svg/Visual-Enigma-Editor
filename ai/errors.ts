export type AIErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "missing_secret"
  | "unsupported_provider"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "provider_error"
  | "invalid_response"
  | "transport_error";

/** Public errors intentionally contain no request body, provider body or key. */
export class AIError extends Error {
  constructor(
    public readonly code: AIErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIError";
  }
}

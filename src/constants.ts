export const IMMEDIATE_STATUS_CODES: ReadonlySet<number> = new Set([401, 402, 403])

export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])

export const BACKOFF_BASE_MS = 2000

export const TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  "rate limit",
  "too many requests",
  "overloaded",
  "capacity exceeded",
  "econnrefused",
  "econnreset",
  "epipe",
  "etimedout",
  "eai_again",
  "fetch failed",
  "connection refused",
  "connection reset",
  "socket hang up",
  "network error",
]

export const PERMANENT_RATE_LIMIT_PATTERNS: readonly string[] = [
  "usage limit",
  "quota exceeded",
  "credit balance",
  "billing",
]

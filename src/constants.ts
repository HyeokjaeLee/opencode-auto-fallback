export const IMMEDIATE_STATUS_CODES: ReadonlySet<number> = new Set([401, 402, 403])

export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])

export const BACKOFF_BASE_MS = 2000

export const RATE_LIMIT_PATTERNS: readonly string[] = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "capacity exceeded",
  "credit balance",
  "billing",
]

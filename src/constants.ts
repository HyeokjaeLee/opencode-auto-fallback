export const IMMEDIATE_STATUS_CODES: ReadonlySet<number> = new Set([
  401, 402, 403,
]);

export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504, 529,
]);

export const BACKOFF_BASE_MS = 2000;

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
];

export const PERMANENT_RATE_LIMIT_PATTERNS: readonly string[] = [
  "usage limit",
  "quota exceeded",
  "credit balance",
  "billing",
];

export const CONTEXT_OVERFLOW_PATTERNS: readonly string[] = [
  "context length",
  "maximum context",
  "too many tokens",
  "token limit",
  "context length exceeded",
  "max_tokens",
  "maximum prompt length",
  "context window",
  "input too long",
  "request too large",
];

/** Delay after aborting a session before sending a new prompt (ms) */
export const ABORT_DELAY_MS = 300;

/** Delay after reverting a session before sending a new prompt (ms) */
export const REVERT_DELAY_MS = 500;

/** Duration for toast notifications (ms) */
export const TOAST_DURATION_MS = 5_000;

/** Duration for long/important toast notifications (ms) */
export const TOAST_DURATION_LONG_MS = 8_000;

/** Text sent to large model after seamless switch to continue the conversation */
export const LARGE_CONTEXT_CONTINUATION = "Continue from where you left off.";

/** Text sent to original model after switch-back from large context model */
export const RETURN_CONTINUATION = "Continue from where you left off.";

export const COMPACTION_FALLBACK_TOKEN_LIMIT = 30_000;

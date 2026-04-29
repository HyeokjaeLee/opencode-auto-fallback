export const IMMEDIATE_PATTERNS: RegExp[] = [
  /quota.?exceeded/i,
  /exceeded\s+your/i,
  /exhausted/i,
  /billing/i,
  /all\s+credentials/i,
  /unauthorized/i,
  /authentication/i,
  /invalid\s+api\s+key/i,
  /access\s+denied/i,
  /model\s+not\s+found/i,
  /model\s+not\s+supported/i,
  /\bapi.?key\b.*\bmissing\b/i,
]

export const RETRYABLE_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /too\s+many\s+requests/i,
  /service\s+unavailable/i,
  /temporarily\s+unavailable/i,
  /try\s+again/i,
  /overloaded/i,
  /cool(?:ing)?\s+down/i,
]

export const IMMEDIATE_STATUS_CODES: ReadonlySet<number> = new Set([401, 402, 403])

export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529])

export const BACKOFF_BASE_MS = 2000

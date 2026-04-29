import { IMMEDIATE_PATTERNS, RETRYABLE_PATTERNS } from "./constants"

export function matchImmediatePattern(text: string): string | undefined {
  for (const pattern of IMMEDIATE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return undefined
}

export function matchRetryablePattern(text: string): string | undefined {
  for (const pattern of RETRYABLE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return undefined
}

export function extractHttpStatus(text: string): number | undefined {
  const match = /\b(\d{3})\b/.exec(text)
  if (match) {
    const code = parseInt(match[1], 10)
    if (code >= 400 && code < 600) return code
  }
  return undefined
}

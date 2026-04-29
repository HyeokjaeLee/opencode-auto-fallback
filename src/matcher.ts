import { IMMEDIATE_FALLBACK_PATTERNS } from "./constants"

export function isImmediateFallback(message: string): boolean {
  const lower = message.toLowerCase()
  return IMMEDIATE_FALLBACK_PATTERNS.some(p => lower.includes(p.toLowerCase()))
}

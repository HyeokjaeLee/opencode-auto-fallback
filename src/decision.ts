import type { FallbackDecision } from "./types"
import { matchImmediatePattern, matchRetryablePattern, extractHttpStatus } from "./matcher"
import { IMMEDIATE_STATUS_CODES, RETRYABLE_STATUS_CODES } from "./constants"

export { type FallbackDecision }

export function classifyError(message: string, cooldownActive: boolean): FallbackDecision {
  if (cooldownActive) return { action: "ignore" }

  const status = extractHttpStatus(message)

  if (status !== undefined && IMMEDIATE_STATUS_CODES.has(status)) {
    return { action: "immediate", httpStatus: status }
  }

  if (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) {
    return { action: "retry", httpStatus: status }
  }

  const immediateMatch = matchImmediatePattern(message)
  if (immediateMatch !== undefined) {
    return { action: "immediate", matchedPattern: immediateMatch }
  }

  const retryMatch = matchRetryablePattern(message)
  if (retryMatch !== undefined) {
    return { action: "retry", matchedPattern: retryMatch }
  }

  return { action: "retry" }
}

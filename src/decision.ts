import type { FallbackDecision } from "./types"
import { IMMEDIATE_STATUS_CODES, RETRYABLE_STATUS_CODES } from "./constants"

export { type FallbackDecision }

export function classifyError(
  statusCode: number | undefined,
  isRetryable: boolean | undefined,
  cooldownActive: boolean,
): FallbackDecision {
  if (cooldownActive) return { action: "ignore" }

  if (statusCode !== undefined && IMMEDIATE_STATUS_CODES.has(statusCode)) {
    return { action: "immediate", httpStatus: statusCode }
  }

  if (isRetryable === true) {
    return { action: "retry", httpStatus: statusCode, isRetryable: true }
  }

  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return { action: "retry", httpStatus: statusCode }
  }

  return { action: "retry", httpStatus: statusCode, isRetryable }
}

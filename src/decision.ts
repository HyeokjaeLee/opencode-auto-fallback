import { isImmediateFallback } from "./matcher"

export type FallbackDecision =
  | { action: "immediate" }
  | { action: "retry" }
  | { action: "ignore" }

export function classifyError(
  message: string,
  cooldownActive: boolean,
): FallbackDecision {
  if (cooldownActive) {
    return { action: "ignore" }
  }

  if (isImmediateFallback(message)) {
    return { action: "immediate" }
  }

  return { action: "retry" }
}

const FALLBACK_MARKER = "<!-- OPENCODE_AUTO_FALLBACK -->";

export function buildFallbackNotificationPart(
  from: string,
  to: string,
  reason: string,
): { type: "text"; text: string } {
  return {
    type: "text" as const,
    text: `[${from} → ${to} / ${reason}]\n${FALLBACK_MARKER}`,
  };
}

export function buildExhaustedNotificationPart(
  from: string,
  reason: string,
): { type: "text"; text: string } {
  return {
    type: "text" as const,
    text: `[${from} / ${reason}]\n${FALLBACK_MARKER}`,
  };
}

export function buildSyntheticContinuationPart(text: string): {
  type: "text";
  text: string;
  synthetic: boolean;
} {
  return {
    type: "text" as const,
    text,
    synthetic: true,
  };
}

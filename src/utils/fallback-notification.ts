export const FALLBACK_MARKER = "<!-- OPENCODE_AUTO_FALLBACK -->";

export function buildFallbackNotificationPart(from: string, to: string, reason: string) {
  return {
    type: "text" as const,
    text: `[${from} -> ${to} / ${reason}]\n${FALLBACK_MARKER}`,
    ignored: true,
  };
}

export function buildConfigWarningPart(opts: {
  invalidAgents: string[];
  invalidModels: string[];
  allowedAgents: string[];
}) {
  const lines: string[] = ["Invalid values detected in fallback.json."];
  if (opts.invalidAgents.length > 0) {
    lines.push(`Agents: [${opts.invalidAgents.join(", ")}]`);
  }
  if (opts.invalidModels.length > 0) {
    lines.push(`Models: [${opts.invalidModels.join(", ")}]`);
  }
  if (opts.allowedAgents.length > 0) {
    lines.push(`Allowed Agents: [${opts.allowedAgents.join(", ")}]`);
  }
  lines.push(FALLBACK_MARKER);

  return {
    type: "text" as const,
    text: lines.join("\n"),
    ignored: true,
  };
}

export function buildSyntheticContinuationPart(text: string) {
  return {
    type: "text" as const,
    text,
    synthetic: true,
  };
}

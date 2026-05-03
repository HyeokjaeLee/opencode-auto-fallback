import type { MessagePart, MessageWithParts, MessageInfo } from "./types";

export type PromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename?: string; url: string }
  | { type: "agent"; name: string };

function isSyntheticPart(part: MessagePart): boolean {
  return part.synthetic === true;
}

function convertToPromptPart(part: MessagePart): PromptPart | null {
  switch (part.type) {
    case "text":
      return part.text ? { type: "text", text: part.text } : null;
    case "file":
      return part.url && part.mime
        ? { type: "file", mime: part.mime, filename: part.filename, url: part.url }
        : null;
    case "agent":
      return part.name ? { type: "agent", name: part.name } : null;
    default:
      return null;
  }
}

export function extractUserParts(
  messages: MessageWithParts[],
  options?: { allowSynthetic?: boolean },
): { info: MessageInfo; parts: PromptPart[] } | null {
  const userMessages = [...messages].reverse().filter((m) => m.info.role === "user");

  for (const message of userMessages) {
    const parts = message.parts
      .filter((p) => (options?.allowSynthetic ?? false) || !isSyntheticPart(p))
      .map((p) => convertToPromptPart(p))
      .filter((p): p is PromptPart => p !== null);

    if (parts.length > 0) return { info: message.info, parts };
  }

  return null;
}

import type { MessageInfo, MessagePart, MessageWithParts } from "@/config/types";

/** Minimal structural view of a prompt message, independent of SDK types. */
export interface PromptInputMessage {
  info: {
    id: string;
    role: string;
    parentID?: string;
    summary?: boolean;
    finish?: string;
    error?: unknown;
  };
  parts: Array<Record<string, unknown> & { type: string }>;
}

export interface CompactionCutResult {
  messages: PromptInputMessage[];
  cutCount: number;
}

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

/**
 * Re-applies the compaction cut upstream `filterCompacted` failed to honor.
 * When a compaction pair's summary assistant ends with an error (e.g. the
 * session was aborted mid-compaction), upstream walks past the boundary and
 * sends the full pre-compaction history on every later request. This finds the
 * last completed pair and rebuilds the kept prefix. When the boundary is
 * intact, upstream already fronts the pair, so the length check makes this an
 * idempotent no-op; only a pair sitting mid-array with pre-compaction messages
 * before it produces a cut.
 */
export function enforceCompactionBoundary(messages: PromptInputMessage[]): CompactionCutResult {
  // Last completed pair = nearest the end: a compaction user whose summary
  // assistant finished with a truthy finish and no error.
  let pairIndex = -1;
  let summaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const assistant = messages[i];
    if (assistant.info.role !== "assistant") continue;
    if (assistant.info.summary !== true || !assistant.info.finish || assistant.info.error) {
      continue;
    }
    const parentID = assistant.info.parentID;
    if (!parentID) continue;
    const parentIndex = messages.findIndex((msg) => msg.info.id === parentID);
    if (parentIndex === -1 || parentIndex >= i) continue;
    const parent = messages[parentIndex];
    if (parent.info.role !== "user") continue;
    if (!parent.parts.some((part) => part.type === "compaction")) continue;
    pairIndex = parentIndex;
    summaryIndex = i;
    break;
  }

  if (pairIndex === -1) return { messages, cutCount: 0 };

  const pair = messages[pairIndex];
  const summary = messages[summaryIndex];

  // The installed SDK types omit tail_start_id, but the v1.18.35 server sends it.
  const compactionPart = pair.parts.find((part) => part.type === "compaction");
  const tailStartId =
    compactionPart &&
    "tail_start_id" in compactionPart &&
    typeof compactionPart.tail_start_id === "string"
      ? compactionPart.tail_start_id
      : undefined;

  const tailIndex = tailStartId ? messages.findIndex((msg) => msg.info.id === tailStartId) : -1;

  let kept: PromptInputMessage[];
  // Same element order as upstream filterCompacted's output: pair + summary
  // first, then the retained tail, then everything after the summary.
  if (tailStartId && tailIndex !== -1 && tailIndex < pairIndex) {
    kept = [
      pair,
      summary,
      ...messages.slice(tailIndex, pairIndex),
      ...messages.slice(summaryIndex + 1),
    ];
  } else {
    kept = [pair, summary, ...messages.slice(summaryIndex + 1)];
  }

  if (kept.length === messages.length) return { messages, cutCount: 0 };
  return { messages: kept, cutCount: messages.length - kept.length };
}

import { CONTEXT_THRESHOLD_RATIO, ESTIMATED_CHARS_PER_TOKEN } from "@/config/constants";
import { getCurrentModel, getModelContextLimit, getModelInputLimit } from "@/state/context-state";

import { serializeError } from "./error";
import { formatModelKey } from "./model";

import type { Logger } from "./session-utils";
import type { PluginInput } from "@opencode-ai/plugin";

interface ContextThresholdResult {
  atThreshold: boolean;
  usage: number;
  limit: number;
}

export interface TokenCountResult {
  assistantTokens: number;
  lastInput: number;
  lastOutput: number;
  lastReasoning: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  asstCount: number;
  estimatedAdditionalTokens: number;
}

export function estimateTokensFromParts(
  parts: Array<{ type: string; text?: unknown; state?: { output?: unknown } }>,
): number {
  let totalChars = 0;
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      totalChars += part.text.length;
    } else if (part.type === "tool" && typeof part.state?.output === "string") {
      totalChars += part.state.output.length;
    }
  }
  return Math.ceil(totalChars / ESTIMATED_CHARS_PER_TOKEN);
}

export function calculateTokenCounts(
  raw: Array<{
    info: {
      role: string;
      tokens?: {
        input: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
    };
    parts?: Array<{ type: string; text?: unknown; state?: { output?: unknown } }>;
  }>,
): TokenCountResult {
  let totalTokens = 0;
  let lastInput = 0;
  let lastOutput = 0;
  let lastReasoning = 0;
  let lastCacheRead = 0;
  let lastCacheWrite = 0;
  let asstCount = 0;
  let lastAsstIndex = -1;

  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (m.info.role === "assistant" && m.info.tokens) {
      asstCount++;
      lastAsstIndex = i;
      const t = m.info.tokens;
      const tokenSum =
        t.input +
        (t.output ?? 0) +
        (t.reasoning ?? 0) +
        (t.cache?.read ?? 0) +
        (t.cache?.write ?? 0);
      if (tokenSum > 0) {
        lastInput = t.input;
        lastOutput = t.output ?? 0;
        lastReasoning = t.reasoning ?? 0;
        lastCacheRead = t.cache?.read ?? 0;
        lastCacheWrite = t.cache?.write ?? 0;
        totalTokens = tokenSum;
      }
    }
  }

  let estimatedAdditionalTokens = 0;
  if (lastAsstIndex >= 0) {
    for (let i = lastAsstIndex + 1; i < raw.length; i++) {
      estimatedAdditionalTokens += estimateTokensFromParts(raw[i].parts ?? []);
    }
  }

  return {
    assistantTokens: totalTokens,
    lastInput,
    lastOutput,
    lastReasoning,
    lastCacheRead,
    lastCacheWrite,
    asstCount,
    estimatedAdditionalTokens,
  };
}

export async function checkContextThreshold(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<ContextThresholdResult> {
  try {
    const msgResp = await context.client.session.messages({
      path: { id: sessionID },
    });
    const raw = (msgResp.data ?? []) as Array<{
      info: {
        role: string;
        tokens?: {
          input: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
      };
      parts?: Array<{ type: string; text?: unknown; state?: { output?: unknown } }>;
    }>;

    const counts = calculateTokenCounts(raw);

    if (counts.asstCount === 0 || counts.assistantTokens === 0) {
      await logger.info("Idle: no assistant messages with token data", {
        sessionID,
      });
      return { atThreshold: false, usage: 0, limit: 0 };
    }

    const curModel = getCurrentModel(sessionID);
    if (!curModel) return { atThreshold: false, usage: 0, limit: 0 };
    const key = formatModelKey(curModel);

    const ctxLimit = getModelContextLimit(key);
    if (!ctxLimit || ctxLimit === 0) return { atThreshold: false, usage: 0, limit: 0 };

    const inputLimit = getModelInputLimit(key);

    const count =
      counts.lastInput +
      counts.lastOutput +
      counts.lastReasoning +
      counts.lastCacheRead +
      counts.lastCacheWrite +
      counts.estimatedAdditionalTokens;
    const usable = inputLimit ?? ctxLimit;

    const atThreshold = count >= usable * CONTEXT_THRESHOLD_RATIO;

    await logger.info("Idle: context check", {
      sessionID,
      asstCount: counts.asstCount,
      count,
      usable,
      usage: count,
      limit: ctxLimit,
      inputLimit,
      lastInput: counts.lastInput,
      lastOutput: counts.lastOutput,
      lastReasoning: counts.lastReasoning,
      lastCacheRead: counts.lastCacheRead,
      lastCacheWrite: counts.lastCacheWrite,
      estimatedAdditionalTokens: counts.estimatedAdditionalTokens,
      atThreshold,
    });
    return { atThreshold, usage: count, limit: ctxLimit };
  } catch (err) {
    await logger.info("Idle: threshold check error", {
      sessionID,
      error: serializeError(err),
    });
    return { atThreshold: false, usage: 0, limit: 0 };
  }
}

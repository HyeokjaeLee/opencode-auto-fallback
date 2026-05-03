import {
  getCompactionReserved,
  getCurrentModel,
  getModelContextLimit,
  getModelInputLimit,
  getModelOutputLimit,
} from "@/state/context-state";

import { serializeError } from "./error";
import { formatModelKey } from "./model";

import type { Logger } from "./session-utils";
import type { PluginInput } from "@opencode-ai/plugin";

export interface ContextThresholdResult {
  atThreshold: boolean;
  usage: number;
  limit: number;
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
    }>;

    let totalTokens = 0;
    let lastInput = 0;
    let lastOutput = 0;
    let lastReasoning = 0;
    let lastCacheRead = 0;
    let lastCacheWrite = 0;
    let asstCount = 0;

    for (const m of raw) {
      if (m.info.role === "assistant" && m.info.tokens) {
        asstCount++;
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

    if (asstCount === 0 || totalTokens === 0) {
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
    const outputLimit = getModelOutputLimit(key);

    const count = lastInput + lastOutput + lastCacheRead + lastCacheWrite;
    const maxOutput = Math.min(outputLimit ?? 32_000, 32_000);
    const configReserved = getCompactionReserved();
    const reserved = configReserved ?? Math.min(20_000, outputLimit ?? maxOutput);
    const usable = inputLimit
      ? Math.max(0, inputLimit - reserved)
      : Math.max(0, ctxLimit - maxOutput);

    const atThreshold = count >= usable;

    await logger.info("Idle: context check", {
      sessionID,
      asstCount,
      count,
      usable,
      usage: count,
      limit: ctxLimit,
      inputLimit,
      outputLimit,
      reserved,
      maxOutput,
      lastInput,
      lastOutput,
      lastReasoning,
      lastCacheRead,
      lastCacheWrite,
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

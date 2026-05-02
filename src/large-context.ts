import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig } from "./types";
import {
  LARGE_CONTEXT_CONTINUATION,
  RETURN_CONTINUATION,
} from "./constants";
import { parseModel } from "./config";
import { isModelInCooldown } from "./provider-state";
import {
  setActiveFallbackParams,
  clearActiveFallbackParams,
  getCurrentModel,
  getOriginalModel,
  setLargeContextPhase,
  getLargeContextPhase,
  deleteLargeContextPhase,
  getModelContextLimit,
  getModelInputLimit,
  getModelOutputLimit,
  setRestoreModel,
  getRestoreModel,
  deleteRestoreModel,
  getSessionOriginalAgent,
  isRegisteredAgent,
  getCompactionReserved,
} from "./state/context-state";
import type { Logger } from "./session-utils";
import { fetchSessionData } from "./session-utils";

export async function hasActiveChildren(
  sessionID: string,
  context: PluginInput,
): Promise<boolean> {
  try {
    const resp = await context.client.session.children({
      path: { id: sessionID },
    });
    const children = (resp?.data ?? []) as Array<{ id: string }>;
    if (children.length === 0) return false;
    const statusResp = await context.client.session.status();
    const allStatuses = (statusResp?.data ?? {}) as Record<
      string,
      { type: string }
    >;
    for (const c of children) {
      const s = allStatuses[c.id];
      if (!s || s.type === "busy" || s.type === "retry") return true;
    }
    return false;
  } catch { /* non-critical: children API may fail, fail-closed to prevent premature return */
    return true;
  }
}

export async function checkContextThreshold(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<{ atThreshold: boolean; usage: number; limit: number }> {
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
    const modelKey = `${curModel.providerID}/${curModel.modelID}`;

    const ctxLimit = getModelContextLimit(modelKey);
    if (!ctxLimit || ctxLimit === 0)
      return { atThreshold: false, usage: 0, limit: 0 };

    const inputLimit = getModelInputLimit(modelKey);
    const outputLimit = getModelOutputLimit(modelKey);

    const count = lastInput + lastOutput + lastCacheRead + lastCacheWrite;
    const maxOutput = Math.min(outputLimit ?? 32_000, 32_000);
    const configReserved = getCompactionReserved();
    const reserved =
      configReserved ?? Math.min(20_000, outputLimit ?? maxOutput);
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
      error: err instanceof Error ? err.message : String(err),
    });
    return { atThreshold: false, usage: 0, limit: 0 };
  }
}

export function shouldSkipLargeContextFallback(
  currentWindow: number,
  largeWindow: number,
  minContextRatio: number,
): boolean {
  return largeWindow / currentWindow <= 1 + minContextRatio;
}

export async function handleLargeContextSwitch(
  sessionID: string,
  lcf: NonNullable<FallbackConfig["largeContextFallback"]>,
  context: PluginInput,
  logger: Logger,
  errorMessage: string,
): Promise<boolean> {
  const phase = getLargeContextPhase(sessionID);
  if (phase === "pending" || phase === "active" || phase === "summarizing")
    return false;

  const agent = getSessionOriginalAgent(sessionID);
  if (!agent || !isRegisteredAgent(agent)) return false;

  const parsed = parseModel(lcf.model);
  if (isModelInCooldown(parsed.providerID, parsed.modelID)) return false;

  setLargeContextPhase(sessionID, "pending");

  try {
    const original = getOriginalModel(sessionID);
    if (!original) {
      deleteLargeContextPhase(sessionID);
      return false;
    }

    const { extracted } = await fetchSessionData(sessionID, context, logger);
    if (!extracted) {
      deleteLargeContextPhase(sessionID);
      return false;
    }

    await logger.info("Switching to large context model", {
      sessionID,
      agent,
      largeModel: lcf.model,
      fromModel: `${original.providerID}/${original.modelID}`,
      reason: errorMessage,
    });

    const currentModel = getCurrentModel(sessionID);
    if (currentModel) {
      setRestoreModel(sessionID, currentModel.providerID, currentModel.modelID);
    }

    setActiveFallbackParams(sessionID, {
      providerID: parsed.providerID,
      modelID: parsed.modelID,
    });

    setLargeContextPhase(sessionID, "active");


    context.client.session
      .prompt({
        path: { id: sessionID },
        body: {
          model: { providerID: parsed.providerID, modelID: parsed.modelID },
          agent,
          parts: [{ type: "text" as const, text: LARGE_CONTEXT_CONTINUATION }],
        },
      })
      .catch(async (err) => {
        await logger.warn(
          "Large model continuation prompt failed (phase already active)",
          {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      });

    return true;
  } catch (err) {
    deleteLargeContextPhase(sessionID);
    clearActiveFallbackParams(sessionID);
    deleteRestoreModel(sessionID);
    await logger.error("Failed to switch to large context model", {
      sessionID,
      largeModel: lcf.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function handleLargeContextReturn(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<void> {
  const original = getRestoreModel(sessionID) ?? getOriginalModel(sessionID);
  if (!original) {
    await logger.error("Return: no original model found, clearing phase", {
      sessionID,
    });
    deleteLargeContextPhase(sessionID);

    return;
  }

  const current = getCurrentModel(sessionID);
  const compactModel = current ?? original;

  await logger.info(
    "Return condition: compacting with large model for switch-back",
    {
      sessionID,
      originalModel: `${original.providerID}/${original.modelID}`,
      compactModel: `${compactModel.providerID}/${compactModel.modelID}`,
    },
  );

  setLargeContextPhase(sessionID, "summarizing");

  try {
    await context.client.session.summarize({
      path: { id: sessionID },
      body: {
        providerID: compactModel.providerID,
        modelID: compactModel.modelID,
      },
    });
    await logger.info("Return: compaction triggered for switch-back", {
      sessionID,
      compactModel,
    });
  } catch (err) {
    await logger.error("Return: compaction failed", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    deleteLargeContextPhase(sessionID);

  }
}

export async function handleLargeContextCompletion(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<void> {
  const original = getRestoreModel(sessionID) ?? getOriginalModel(sessionID);
  if (!original) {
    await logger.error("Switch-back: no original model found, clearing phase", {
      sessionID,
    });
    deleteLargeContextPhase(sessionID);

    return;
  }

  await logger.info(
    "Large context work done, compaction complete, restoring model",
    {
      sessionID,
      originalModel: `${original.providerID}/${original.modelID}`,
    },
  );

  deleteLargeContextPhase(sessionID);
  deleteRestoreModel(sessionID);

  context.client.session
    .prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: original.providerID, modelID: original.modelID },
        parts: [{ type: "text" as const, text: RETURN_CONTINUATION }],
      },
    })
    .catch(async (err) => {
      await logger.warn("Switch-back: continuation prompt failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  await logger.info(
    "Switch-back: continuation sent, session resumed on original model",
    {
      sessionID,
      model: `${original.providerID}/${original.modelID}`,
    },
  );
}

import { getAgentLargeContextModel } from "@/config/config";
import {
  CONTEXT_THRESHOLD_RATIO,
  LARGE_CONTEXT_CONTINUATION,
  RETURN_CONTINUATION,
} from "@/config/constants";
import type { FallbackConfig, ResolvedModel } from "@/config/types";
import {
  clearActiveFallbackParams,
  deleteLargeContextPhase,
  deleteRestoreModel,
  getCurrentModel,
  getLargeContextPhase,
  getModelContextLimit,
  getModelInputLimit,
  getOriginalModel,
  getRecoveryModel,
  getSessionOriginalAgent,
  isRegisteredAgent,
  resetSelfCompactionCount,
  setActiveFallbackParams,
  setLargeContextPhase,
  setRestoreModel,
  setReturnDeferred,
  clearSyntheticPromptActive,
  setSyntheticPromptActive,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { serializeError } from "@/utils/error";
import {
  buildFallbackNotificationPart,
  buildSyntheticContinuationPart,
} from "@/utils/fallback-notification";
import { formatModelKey } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSessionSafely, fetchSessionData, showTuiNotification } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export function shouldSkipLargeContextFallback(
  currentWindow: number,
  largeWindow: number,
  minContextRatio: number,
): boolean {
  return largeWindow / currentWindow <= 1 + minContextRatio;
}

async function checkContextThresholdForModel(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
  model: { providerID: string; modelID: string },
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

    for (const m of raw) {
      if (m.info.role === "assistant" && m.info.tokens) {
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

    if (totalTokens === 0) {
      return { atThreshold: false, usage: 0, limit: 0 };
    }

    const modelKey = formatModelKey(model);
    const ctxLimit = getModelContextLimit(modelKey);
    if (!ctxLimit || ctxLimit === 0) {
      return { atThreshold: true, usage: totalTokens, limit: 0 };
    }

    const inputLimit = getModelInputLimit(modelKey);
    const count = lastInput + lastOutput + lastReasoning + lastCacheRead + lastCacheWrite;
    const usable = inputLimit ?? ctxLimit;

    const atThreshold = count >= usable * CONTEXT_THRESHOLD_RATIO;

    await logger.info("Context threshold check for model", {
      sessionID,
      model: modelKey,
      count,
      usable,
      usage: count,
      limit: ctxLimit,
      atThreshold,
    });

    return { atThreshold, usage: count, limit: ctxLimit };
  } catch (err) {
    await logger.info("Context threshold check error", {
      sessionID,
      model: formatModelKey(model),
      error: serializeError(err),
    });
    return { atThreshold: false, usage: 0, limit: 0 };
  }
}

export async function handleLargeContextSwitch(
  sessionID: string,
  largeModel: ResolvedModel,
  context: PluginInput,
  logger: Logger,
  errorMessage: string,
): Promise<boolean> {
  const phase = getLargeContextPhase(sessionID);
  if (phase === "pending" || phase === "active" || phase === "summarizing") return false;

  const agent = getSessionOriginalAgent(sessionID);
  if (!agent || !isRegisteredAgent(agent)) return false;

  if (isModelInCooldown(largeModel.providerID, largeModel.modelID)) return false;

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
      largeModel: formatModelKey(largeModel),
      fromModel: formatModelKey(original),
      reason: errorMessage,
    });

    const currentModel = getCurrentModel(sessionID);
    if (currentModel) {
      setRestoreModel(sessionID, currentModel.providerID, currentModel.modelID);
    }

    setActiveFallbackParams(sessionID, {
      providerID: largeModel.providerID,
      modelID: largeModel.modelID,
    });

    setLargeContextPhase(sessionID, "active");

    await showTuiNotification(
      context,
      sessionID,
      [
        buildFallbackNotificationPart(
          formatModelKey(original),
          formatModelKey(largeModel),
          "Switching to large context model",
        ),
      ],
      logger,
    );

    setSyntheticPromptActive(sessionID);
    context.client.session
      .prompt({
        path: { id: sessionID },
        body: {
          model: { providerID: largeModel.providerID, modelID: largeModel.modelID },
          agent,
          parts: [buildSyntheticContinuationPart(LARGE_CONTEXT_CONTINUATION)],
        },
      })
      .catch(async (err) => {
        await logger.warn("Large model continuation prompt failed (phase already active)", {
          sessionID,
          error: serializeError(err),
        });
      })
      .finally(() => {
        clearSyntheticPromptActive(sessionID);
      });

    return true;
  } catch (err) {
    deleteLargeContextPhase(sessionID);
    clearActiveFallbackParams(sessionID);
    deleteRestoreModel(sessionID);
    await logger.error("Failed to switch to large context model", {
      sessionID,
      largeModel: formatModelKey(largeModel),
      error: serializeError(err),
    });
    return false;
  }
}

export async function handleLargeContextReturn(
  sessionID: string,
  config: FallbackConfig,
  context: PluginInput,
  logger: Logger,
): Promise<void> {
  const original = getRecoveryModel(sessionID);
  if (!original) {
    await logger.error("Return: no original model found, clearing phase", {
      sessionID,
    });
    deleteLargeContextPhase(sessionID);

    return;
  }

  const agent = getSessionOriginalAgent(sessionID);
  const largeModel = agent ? getAgentLargeContextModel(config, agent) : null;
  const compactModel = largeModel ?? original;

  await logger.info("Return condition: compacting with large model for switch-back", {
    sessionID,
    originalModel: formatModelKey(original),
    compactModel: formatModelKey(compactModel),
  });

  setLargeContextPhase(sessionID, "summarizing");

  try {
    await abortSessionSafely(sessionID, context);

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
      error: serializeError(err),
    });
    deleteLargeContextPhase(sessionID);
  }
}

export async function handleLargeContextCompletion(
  sessionID: string,
  config: FallbackConfig,
  context: PluginInput,
  logger: Logger,
): Promise<void> {
  const original = getRecoveryModel(sessionID);
  if (!original) {
    await logger.error("Switch-back: no original model found, clearing phase", {
      sessionID,
    });
    deleteLargeContextPhase(sessionID);

    return;
  }

  // Check if original model can handle the compacted context
  const thresholdCheck = await checkContextThresholdForModel(sessionID, context, logger, original);

  const canFitOnOriginal = !thresholdCheck.atThreshold;

  await logger.info("Large context work done, compaction complete", {
    sessionID,
    originalModel: formatModelKey(original),
    canFitOnOriginal,
    contextUsage: thresholdCheck.usage,
    contextLimit: thresholdCheck.limit,
  });

  if (canFitOnOriginal) {
    deleteLargeContextPhase(sessionID);
    deleteRestoreModel(sessionID);
    resetSelfCompactionCount(sessionID);

    await showTuiNotification(
      context,
      sessionID,
      [
        buildFallbackNotificationPart(
          formatModelKey(getCurrentModel(sessionID) ?? original),
          formatModelKey(original),
          "Returning to default context model",
        ),
      ],
      logger,
    );

    let promptFailed = false;
    setSyntheticPromptActive(sessionID);
    try {
      await context.client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID: original.providerID, modelID: original.modelID },
          parts: [buildSyntheticContinuationPart(RETURN_CONTINUATION)],
        },
      });
    } catch (err) {
      promptFailed = true;
      await logger.warn("Switch-back: continuation prompt failed", {
        sessionID,
        error: serializeError(err),
      });
    }
    clearSyntheticPromptActive(sessionID);

    if (promptFailed) {
      await logger.info("Switch-back: prompt failed, restoring phase for retry", {
        sessionID,
        model: formatModelKey(original),
      });
      setLargeContextPhase(sessionID, "active");
      setRestoreModel(sessionID, original.providerID, original.modelID);
    } else {
      await logger.info("Switch-back: continuation sent, session resumed on original model", {
        sessionID,
        model: formatModelKey(original),
      });
    }
  } else {
    await logger.info("Switch-back: context still too large, staying on large model", {
      sessionID,
      originalModel: formatModelKey(original),
      usage: thresholdCheck.usage,
      limit: thresholdCheck.limit,
    });

    setLargeContextPhase(sessionID, "active");
    setReturnDeferred(sessionID);
    resetSelfCompactionCount(sessionID);

    const agent = getSessionOriginalAgent(sessionID);
    const largeModel = agent ? getAgentLargeContextModel(config, agent) : null;
    if (largeModel) {
      setSyntheticPromptActive(sessionID);
      context.client.session
        .prompt({
          path: { id: sessionID },
          body: {
            model: { providerID: largeModel.providerID, modelID: largeModel.modelID },
            parts: [buildSyntheticContinuationPart(RETURN_CONTINUATION)],
          },
        })
        .catch(async (err) => {
          await logger.warn("Large model continuation prompt failed", {
            sessionID,
            error: serializeError(err),
          });
        })
        .finally(() => {
          clearSyntheticPromptActive(sessionID);
        });
    }
  }
}

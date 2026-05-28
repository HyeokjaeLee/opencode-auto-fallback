import type { PluginInput } from "@opencode-ai/plugin";
import { getAgentLargeContextModel } from "@/config/config";
import {
  LARGE_CONTEXT_CONTINUATION,
  RETURN_CONTINUATION,
  TOAST_DURATION_MS,
} from "@/config/constants";
import type { FallbackConfig, ResolvedModel } from "@/config/types";
import {
  clearActiveFallbackParams,
  deleteLargeContextPhase,
  deleteRestoreModel,
  getCurrentModel,
  getLargeContextPhase,
  getOriginalModel,
  getRecoveryModel,
  getSessionOriginalAgent,
  isRegisteredAgent,
  setActiveFallbackParams,
  setLargeContextPhase,
  setRestoreModel,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { serializeError } from "@/utils/error";
import { buildSyntheticContinuationPart } from "@/utils/fallback-notification";
import { formatModelKey } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSessionSafely, fetchSessionData, showToastSafely } from "@/utils/session-utils";

export function shouldSkipLargeContextFallback(
  currentWindow: number,
  largeWindow: number,
  minContextRatio: number,
): boolean {
  return largeWindow / currentWindow <= 1 + minContextRatio;
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

    await showToastSafely(
      context,
      {
        title: "Large context model",
        message: `${formatModelKey(original)} → ${formatModelKey(largeModel)}`,
        variant: "info",
        duration: TOAST_DURATION_MS,
      },
      logger,
    );

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

  await logger.info("Large context work done, compaction complete, restoring model", {
    sessionID,
    originalModel: formatModelKey(original),
  });

  deleteLargeContextPhase(sessionID);
  deleteRestoreModel(sessionID);

  await showToastSafely(
    context,
    {
      title: "Return to default model",
      message: `${formatModelKey(getCurrentModel(sessionID) ?? original)} → ${formatModelKey(original)}`,
      variant: "info",
      duration: TOAST_DURATION_MS,
    },
    logger,
  );

  context.client.session
    .prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: original.providerID, modelID: original.modelID },
        parts: [buildSyntheticContinuationPart(RETURN_CONTINUATION)],
      },
    })
    .catch(async (err) => {
      await logger.warn("Switch-back: continuation prompt failed", {
        sessionID,
        error: serializeError(err),
      });
    });

  await logger.info("Switch-back: continuation sent, session resumed on original model", {
    sessionID,
    model: formatModelKey(original),
  });
}

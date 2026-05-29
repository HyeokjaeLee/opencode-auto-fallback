import { getAgentLargeContextModel } from "@/config/config";
import type { FallbackConfig } from "@/config/types";
import {
  classifyError,
  isContextOverflowError,
  isPermanentRateLimitMessage,
  isUnsupportedContentError,
} from "@/core/decision";
import { handleImmediate, handleRetry } from "@/core/fallback";
import { handleLargeContextSwitch } from "@/core/large-context";
import {
  clearActiveFallbackParams,
  clearCompactionTarget,
  deleteLargeContextPhase,
  deleteRestoreModel,
  getCurrentModel,
  getLargeContextPhase,
  getSessionCooldownModel,
  getSessionOriginalAgent,
  isRegisteredAgent,
  setCompactionTarget,
} from "@/state/context-state";
import { isCooldownActive } from "@/state/session-state";
import { isSameModel } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSessionSafely } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function handleSessionError(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as {
    sessionID?: string;
    error?: {
      name: string;
      data: {
        message: string;
        statusCode?: number;
        isRetryable?: boolean;
        providerID?: string;
      };
    };
  };
  const sessionID = props.sessionID;
  if (!sessionID) {
    await logger.warn("session.error event without sessionID", { event });
    return;
  }

  const err = props.error;
  if (!err) {
    await logger.info("session.error event without error payload", {
      sessionID,
    });
    return;
  }

  if (err.name === "MessageAbortedError") {
    await logger.info("User-initiated abort, ignoring", { sessionID });
    return;
  }

  if (err.data.message && isPermanentRateLimitMessage(err.data.message)) {
    await logger.info("Permanent rate limit / credit error, skipping context overflow check", {
      sessionID,
      message: err.data.message,
    });
  } else if (err.data.message && isContextOverflowError(err.data.message)) {
    const agent = getSessionOriginalAgent(sessionID);
    const parsedModel = agent ? getAgentLargeContextModel(config, agent) : null;

    if (parsedModel && agent && isRegisteredAgent(agent)) {
      await abortSessionSafely(sessionID, context);

      const phase = getLargeContextPhase(sessionID);

      if (phase === "active") {
        setCompactionTarget(sessionID, "large");
        try {
          await context.client.session.summarize({
            path: { id: sessionID },
            body: {
              providerID: parsedModel.providerID,
              modelID: parsedModel.modelID,
            },
          });
        } catch {
          clearCompactionTarget(sessionID);
        }
        return;
      }

      const switched = await handleLargeContextSwitch(
        sessionID,
        parsedModel,
        context,
        logger,
        err.data.message,
      );
      if (switched) return;
    } else {
      const curModel = getCurrentModel(sessionID);
      await logger.info("Error: context overflow for non-registered agent, manual compact", {
        sessionID,
      });
      try {
        await context.client.session.summarize({
          path: { id: sessionID },
          ...(curModel
            ? {
                body: {
                  providerID: curModel.providerID,
                  modelID: curModel.modelID,
                },
              }
            : {}),
        });
      } catch {
        /* fall through to normal error handling */
      }
      return;
    }
  }

  if (err.data.message && isUnsupportedContentError(err.data.message)) {
    await logger.warn("Unsupported content error, skipping retry/fallback", {
      sessionID,
      message: err.data.message,
    });
    return;
  }

  const phase = getLargeContextPhase(sessionID);
  if (
    phase === "summarizing" &&
    err.data.message.includes("Tool call not allowed while generating summary")
  ) {
    const agent = getSessionOriginalAgent(sessionID);
    const parsedModel = agent ? getAgentLargeContextModel(config, agent) : null;
    if (parsedModel) {
      await logger.info("Compaction tool call blocked, aborting and retrying summarize", {
        sessionID,
        model: `${parsedModel.providerID}/${parsedModel.modelID}`,
      });
      try {
        await abortSessionSafely(sessionID, context);

        await context.client.session.summarize({
          path: { id: sessionID },
          body: {
            providerID: parsedModel.providerID,
            modelID: parsedModel.modelID,
          },
        });
      } catch (retryErr) {
        await logger.warn("Compaction retry failed, clearing phase", {
          sessionID,
          error: String(retryErr),
        });
        deleteLargeContextPhase(sessionID);
        clearActiveFallbackParams(sessionID);
        deleteRestoreModel(sessionID);
      }
    } else {
      await logger.warn("Compaction failed but no model to retry, clearing phase", { sessionID });
      deleteLargeContextPhase(sessionID);
    }
    return;
  }

  const isAuthError = err.name === "ProviderAuthError";
  const isModelNotFoundError =
    err.name === "ProviderModelNotFoundError" || err.data.message.includes("Model not found");
  const statusCode: number | undefined = err.data.statusCode;
  const isRetryable: boolean | undefined =
    isAuthError || isModelNotFoundError ? false : err.data.isRetryable;

  await logger.info("session.error detected", {
    sessionID,
    errorName: err.name,
    statusCode,
    isRetryable,
    message: err.data.message,
  });

  const cooldownActive = isCooldownActive(sessionID);
  if (cooldownActive) {
    const currentModel = getCurrentModel(sessionID);
    const cooldownModel = getSessionCooldownModel(sessionID);
    if (currentModel && cooldownModel && !isSameModel(currentModel, cooldownModel)) {
      await logger.info("Model changed during cooldown, allowing error through", {
        sessionID,
        currentModel,
        cooldownModel,
      });
    } else {
      await logger.info("session.error during cooldown, ignoring", {
        sessionID,
      });
      return;
    }
  }

  const decision = classifyError(statusCode, isRetryable, false);

  if (decision.action === "immediate") {
    await logger.info("Immediate error via session.error", {
      sessionID,
      httpStatus: decision.httpStatus,
      isRetryable: decision.isRetryable,
    });
    await handleImmediate(sessionID, config, logger, context);
    return;
  }

  if (decision.action === "retry") {
    await logger.info("Retryable error via session.error", {
      sessionID,
      httpStatus: decision.httpStatus,
      isRetryable: decision.isRetryable,
    });
    await handleRetry(sessionID, config, logger, context);
  }
}

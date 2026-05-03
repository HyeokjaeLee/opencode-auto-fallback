import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig } from "@/config/types";
import { getParsedLcfModel } from "@/config/config";
import { classifyError, isContextOverflowError } from "@/core/decision";
import { isCooldownActive } from "@/state/session-state";
import {
  getCurrentModel,
  getLargeContextPhase,
  setCompactionTarget,
  clearCompactionTarget,
  getSessionOriginalAgent,
  isRegisteredAgent,
  getSessionCooldownModel,
} from "@/state/context-state";
import type { Logger } from "@/utils/session-utils";
import { isSameModel } from "@/utils/model";
import { abortSessionSafely } from "@/utils/session-utils";
import { handleRetry, handleImmediate } from "@/core/fallback";
import { handleLargeContextSwitch } from "@/core/large-context";

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

  // Context overflow detection
  if (err.data.message && isContextOverflowError(err.data.message)) {
    const lcf = config.largeContextFallback;
    if (lcf) {
      await abortSessionSafely(sessionID, context);

      const phase = getLargeContextPhase(sessionID);
      const agent = getSessionOriginalAgent(sessionID);

      if (phase === "active") {
        const lcfParsed = getParsedLcfModel(config);
        if (!lcfParsed) return;
        setCompactionTarget(sessionID, "large");
        try {
          await context.client.session.summarize({
            path: { id: sessionID },
            body: {
              providerID: lcfParsed.providerID,
              modelID: lcfParsed.modelID,
            },
          });
        } catch {
          /* non-critical: summarize may fail if session aborted mid-call */
          clearCompactionTarget(sessionID);
        }
        return;
      }

      if (agent && isRegisteredAgent(agent)) {
        const switched = await handleLargeContextSwitch(
          sessionID,
          lcf,
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

  // Model-aware cooldown
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

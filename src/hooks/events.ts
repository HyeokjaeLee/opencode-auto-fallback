import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig } from "@/config/types";
import { LARGE_CONTEXT_CONTINUATION } from "@/config/constants";
import { getParsedLcfModel } from "@/config/config";
import {
  classifyError,
  isTransientErrorMessage,
  isPermanentRateLimitMessage,
  isContextOverflowError,
} from "@/core/decision";
import { isCooldownActive, resetIfExpired, removeSession } from "@/state/session-state";
import { isModelInCooldown, cleanupExpired } from "@/state/provider-state";
import {
  getCurrentModel,
  getLargeContextPhase,
  deleteLargeContextPhase,
  setCompactionTarget,
  clearCompactionTarget,
  getSessionOriginalAgent,
  isRegisteredAgent,
  getModelContextLimit,
  cleanupSession,
  setSessionOriginalAgent,
  getSessionCooldownModel,
} from "@/state/context-state";
import type { Logger } from "@/utils/session-utils";
import { formatModelKey, isSameModel } from "@/utils/model";
import { serializeError } from "@/utils/error";
import { abortSession, abortSessionSafely, fetchSessionData } from "@/utils/session-utils";
import { handleRetry, handleImmediate } from "@/core/fallback";
import {
  handleLargeContextSwitch,
  handleLargeContextReturn,
  handleLargeContextCompletion,
  shouldSkipLargeContextFallback,
} from "@/core/large-context";
import { checkContextThreshold } from "@/utils/context";

export function createEventHandler(config: FallbackConfig, logger: Logger, context: PluginInput) {
  return async ({ event }: { event: { type: string; properties: unknown } }) => {
    if (event.type === "session.error") {
      await handleSessionError(config, logger, context, event);
    } else if (event.type === "session.compacted") {
      await handleSessionCompacted(config, logger, context, event);
    } else if (event.type === "session.idle") {
      await handleSessionIdle(config, logger, context, event);
    } else if (event.type === "session.status") {
      await handleSessionStatus(config, logger, context, event);
    } else if (event.type === "session.deleted") {
      await handleSessionDeleted(logger, event);
    }
  };
}

async function handleSessionError(
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

async function handleSessionCompacted(
  _config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { sessionID: string };
  const phase = getLargeContextPhase(props.sessionID);
  await logger.info("Compacted event received", {
    sessionID: props.sessionID,
    phase,
  });

  if (phase === "summarizing") {
    await logger.info("Compacted: summarizing complete, next idle will switch back", {
      sessionID: props.sessionID,
    });
    return;
  }

  if (phase === "active") {
    await logger.info("Compacted: large model compaction complete, continuing on large model", {
      sessionID: props.sessionID,
    });
    context.client.session
      .prompt({
        path: { id: props.sessionID },
        body: {
          parts: [
            {
              type: "text" as const,
              text: LARGE_CONTEXT_CONTINUATION,
            },
          ],
        },
      })
      .catch(async (err) => {
        await logger.warn("Self-compaction: continuation prompt failed", {
          sessionID: props.sessionID,
          error: serializeError(err),
        });
      });
  }
}

async function handleSessionIdle(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { sessionID: string };
  const phase = getLargeContextPhase(props.sessionID);
  const lcf = config.largeContextFallback;
  let agent = getSessionOriginalAgent(props.sessionID);

  // Recover agent if missing or not registered
  if (lcf && (!agent || (agent && !isRegisteredAgent(agent)))) {
    const previousAgent = agent;
    try {
      const { extracted, messages } = await fetchSessionData(props.sessionID, context, logger);
      let recovered: string | undefined;
      if (extracted?.info.agent && isRegisteredAgent(extracted.info.agent)) {
        recovered = extracted.info.agent;
      } else {
        const found = [...messages]
          .reverse()
          .find((m) => m.info.role === "user" && m.info.agent && isRegisteredAgent(m.info.agent));
        recovered = found?.info.agent;
      }
      if (recovered) {
        agent = recovered;
        setSessionOriginalAgent(props.sessionID, recovered);
        await logger.info("Idle: recovered agent", {
          sessionID: props.sessionID,
          agent: recovered,
          previousAgent,
        });
      }
    } catch {
      await logger.info("Idle: failed to recover agent", {
        sessionID: props.sessionID,
      });
    }
  }

  // No phase — threshold check for model switch
  if (!phase) {
    if (!lcf || !agent) return;

    const thresholdResult = await checkContextThreshold(props.sessionID, context, logger);
    if (!thresholdResult.atThreshold) return;

    if (isRegisteredAgent(agent)) {
      await logger.info("Idle: registered agent at threshold, checking guards", {
        sessionID: props.sessionID,
        agent,
        usage: thresholdResult.usage,
        limit: thresholdResult.limit,
      });
      const parsedModel = getParsedLcfModel(config);
      if (!parsedModel) return;
      const curModel = getCurrentModel(props.sessionID);
      if (curModel) {
        // Guard: already on large model
        if (isSameModel(curModel, parsedModel)) {
          await logger.info("Idle: guard — already on large model", {
            sessionID: props.sessionID,
            model: formatModelKey(curModel),
          });
          return;
        }
        // Guard: large model in cooldown
        if (isModelInCooldown(parsedModel.providerID, parsedModel.modelID)) {
          await logger.info("Idle: guard — large model in cooldown", {
            sessionID: props.sessionID,
            model: lcf.model,
          });
          return;
        }
        // Guard: context window ratio
        const largeLimit = getModelContextLimit(formatModelKey(parsedModel));
        if (
          largeLimit &&
          shouldSkipLargeContextFallback(
            thresholdResult.limit,
            largeLimit,
            lcf.minContextRatio ?? 0.1,
          )
        ) {
          await logger.info("Idle: guard — context window ratio too small", {
            sessionID: props.sessionID,
            currentLimit: thresholdResult.limit,
            largeLimit,
            minRatio: lcf.minContextRatio ?? 0.1,
          });
          return;
        }
      }
      await logger.info("Idle: all guards passed, switching to large model", {
        sessionID: props.sessionID,
        largeModel: lcf.model,
      });
      const switched = await handleLargeContextSwitch(
        props.sessionID,
        lcf,
        context,
        logger,
        `Context at ${((thresholdResult.usage / thresholdResult.limit) * 100).toFixed(1)}%`,
      );
      await logger.info("Idle: large context switch result", {
        sessionID: props.sessionID,
        success: switched,
      });
    } else {
      // Non-registered agent: manually compact
      const curModel = getCurrentModel(props.sessionID);
      await logger.info("Idle: non-registered agent threshold reached, triggering manual compact", {
        sessionID: props.sessionID,
        agent,
      });
      await context.client.session.summarize({
        path: { id: props.sessionID },
        ...(curModel
          ? {
              body: {
                providerID: curModel.providerID,
                modelID: curModel.modelID,
              },
            }
          : {}),
      });
    }
    return;
  }

  // Phase: pending — wait
  if (phase === "pending") {
    return;
  }

  // Phase: active — check self-compaction or return condition
  if (phase === "active") {
    if (!lcf) {
      await logger.info("Idle: active — lcf not configured, clearing phase", {
        sessionID: props.sessionID,
      });
      deleteLargeContextPhase(props.sessionID);
      return;
    }

    // Priority 1: self-compaction if at threshold
    const largeThreshold = await checkContextThreshold(props.sessionID, context, logger);
    if (largeThreshold.atThreshold) {
      await logger.info("Idle: large model context full, self-compacting", {
        sessionID: props.sessionID,
      });
      const lcfParsed = getParsedLcfModel(config);
      if (!lcfParsed) return;
      setCompactionTarget(props.sessionID, "large");
      try {
        await context.client.session.summarize({
          path: { id: props.sessionID },
          body: {
            providerID: lcfParsed.providerID,
            modelID: lcfParsed.modelID,
          },
        });
      } catch {
        /* non-critical: self-compaction may fail if session state changed */
        clearCompactionTarget(props.sessionID);
        await logger.info("Idle: self-compaction failed, cleared compactionTarget", {
          sessionID: props.sessionID,
        });
      }
      return;
    }

    // Priority 2: return condition
    let autoContinuePending = false;
    try {
      const msgResp = await context.client.session.messages({
        path: { id: props.sessionID },
      });
      const raw = (msgResp.data ?? []) as Array<{
        info: { role: string };
        parts: Array<{ type: string; state?: { status: string } }>;
      }>;
      const lastAsst = [...raw].reverse().find((m) => m.info.role === "assistant");
      if (lastAsst) {
        autoContinuePending = lastAsst.parts.some(
          (p) =>
            p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running"),
        );
      }
    } catch {
      /* safe default: assume no auto-continue pending */
    }

    if (!autoContinuePending) {
      await logger.info("Idle: return condition met (no pending tools)", {
        sessionID: props.sessionID,
      });
      await handleLargeContextReturn(props.sessionID, context, logger);
      return;
    }
    await logger.info("Idle: return waiting — pending tool calls in last response", {
      sessionID: props.sessionID,
    });
    return;
  }

  // Phase: summarizing — complete switch-back
  if (lcf) {
    await handleLargeContextCompletion(props.sessionID, context, logger);
  }
}

async function handleSessionStatus(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as {
    sessionID: string;
    status: {
      type: "idle" | "retry" | "busy";
      attempt?: number;
      message?: string;
      next?: number;
    };
  };

  const statusType = props.status.type;
  if (statusType === "busy" || statusType === "idle") {
    const phase = getLargeContextPhase(props.sessionID);
    const agent = getSessionOriginalAgent(props.sessionID);
    await logger.info(`Session status: ${statusType}`, {
      sessionID: props.sessionID,
      phase: phase ?? "none",
      agent: agent ?? "unknown",
    });
  }

  if (props.status.type === "retry" && props.status.message) {
    if (isPermanentRateLimitMessage(props.status.message)) {
      if (isCooldownActive(props.sessionID)) {
        await logger.info("Permanent rate-limit during cooldown, ignoring", {
          sessionID: props.sessionID,
        });
        return;
      }

      await logger.info("Permanent rate-limit detected, falling back immediately", {
        sessionID: props.sessionID,
        message: props.status.message,
      });

      await abortSession(props.sessionID, context);
      await handleImmediate(props.sessionID, config, logger, context);
      return;
    }

    if (isTransientErrorMessage(props.status.message)) {
      const attempt = props.status.attempt ?? 1;

      if (attempt <= config.maxRetries) {
        await logger.info("Allowing opencode retry within maxRetries", {
          sessionID: props.sessionID,
          attempt,
          maxRetries: config.maxRetries,
          message: props.status.message,
        });
        return;
      }

      await logger.info("Transient rate-limit retries exhausted, falling back", {
        sessionID: props.sessionID,
        message: props.status.message,
        attempt,
        maxRetries: config.maxRetries,
        cooldownActive: isCooldownActive(props.sessionID),
      });

      if (isCooldownActive(props.sessionID)) {
        await logger.info("Retry event during cooldown, ignoring", {
          sessionID: props.sessionID,
        });
        return;
      }

      await abortSession(props.sessionID, context);
      await handleImmediate(props.sessionID, config, logger, context);
      return;
    }
  }

  if (props.status.type === "idle" && resetIfExpired(props.sessionID)) {
    const removed = cleanupExpired();
    await logger.info("Cooldown expired, state reset", {
      sessionID: props.sessionID,
      expiredCooldowns: removed,
    });
  }
}

async function handleSessionDeleted(
  logger: Logger,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { info?: { id?: string } };
  if (props.info?.id) {
    removeSession(props.info.id);
    cleanupSession(props.info.id);
    await logger.info("Session cleaned up", { sessionID: props.info.id });
  }
}

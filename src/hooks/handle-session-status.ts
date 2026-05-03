import type { FallbackConfig } from "@/config/types";
import { isTransientErrorMessage, isPermanentRateLimitMessage } from "@/core/decision";
import { handleImmediate } from "@/core/fallback";
import { getLargeContextPhase, getSessionOriginalAgent } from "@/state/context-state";
import { cleanupExpired } from "@/state/provider-state";
import { isCooldownActive, resetIfExpired } from "@/state/session-state";
import type { Logger } from "@/utils/session-utils";
import { abortSession } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function handleSessionStatus(
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

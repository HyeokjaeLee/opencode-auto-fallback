import { getFallbackChain } from "@/config/config";
import { BACKOFF_BASE_MS, LARGE_CONTEXT_CONTINUATION } from "@/config/constants";
import type { FallbackConfig, FallbackModel } from "@/config/types";
import {
  deleteLargeContextPhase,
  getCurrentModel,
  getLargeContextPhase,
  getSessionOriginalAgent,
  setActiveFallbackParams,
  setSessionCooldownModel,
} from "@/state/context-state";
import { isModelInCooldown, markModelCooldown } from "@/state/provider-state";
import { activateCooldown, incrementBackoff, resetBackoff } from "@/state/session-state";
import { serializeError } from "@/utils/error";
import {
  buildExhaustedNotificationPart,
  buildFallbackNotificationPart,
  buildSyntheticContinuationPart,
} from "@/utils/fallback-notification";
import { formatModelKey } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSession, showTuiNotification } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function fallbackToModel(
  sessionID: string,
  agent: string | undefined,
  fromModel: { providerID: string; modelID: string } | null,
  toModel: FallbackModel,
  reason: string,
  logger: Logger,
  context: PluginInput,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, toModel);
    if (fromModel) {
      await showTuiNotification(
        context,
        sessionID,
        [buildFallbackNotificationPart(formatModelKey(fromModel), formatModelKey(toModel), reason)],
        logger,
      );
    }
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: toModel.providerID, modelID: toModel.modelID },
        agent,
        parts: [buildSyntheticContinuationPart(LARGE_CONTEXT_CONTINUATION)],
        ...(toModel.variant ? { variant: toModel.variant } : {}),
      },
    });
    return true;
  } catch (err) {
    await logger.warn("Fallback prompt failed", {
      sessionID,
      model: toModel,
      error: serializeError(err),
    });
    return false;
  }
}

async function getValidatedFallbackChain(
  config: FallbackConfig,
  agent: string | undefined,
  sessionID: string,
  logger: Logger,
): Promise<FallbackModel[]> {
  const chain = getFallbackChain(config, agent);
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", {
      sessionID,
      agent,
    });
  }
  return chain;
}

export async function tryFallbackChain(
  sessionID: string,
  chain: FallbackModel[],
  agent: string | undefined,
  fromModel: { providerID: string; modelID: string } | null,
  reason: string,
  logger: Logger,
  context: PluginInput,
): Promise<boolean> {
  for (let i = 0; i < chain.length; i++) {
    if (isModelInCooldown(chain[i].providerID, chain[i].modelID)) {
      await logger.info(`Skipping model in cooldown ${formatModelKey(chain[i])}`, {
        sessionID,
        model: chain[i],
        remaining: chain.length - i - 1,
      });
      continue;
    }
    await logger.info(`Trying fallback ${i + 1}/${chain.length}`, {
      sessionID,
      model: chain[i],
    });
    if (await fallbackToModel(sessionID, agent, fromModel, chain[i], reason, logger, context)) {
      await logger.info("Fallback chain succeeded", {
        sessionID,
        triedCount: i + 1,
      });
      return true;
    }
  }
  await showTuiNotification(
    context,
    sessionID,
    [buildExhaustedNotificationPart(fromModel ? formatModelKey(fromModel) : "unknown", "All fallback models exhausted")],
    logger,
  );
  await logger.error("All fallback models exhausted", {
    sessionID,
    chainLength: chain.length,
  });
  return false;
}

export async function handleRetry(
  sessionID: string,
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
): Promise<void> {
  const phase = getLargeContextPhase(sessionID);
  if (phase === "active" || phase === "pending" || phase === "summarizing") {
    await logger.info("Skipping retry — large context phase active", {
      sessionID,
      phase,
    });
    return;
  }

  const backoffLevel = incrementBackoff(sessionID);
  const currentModel = getCurrentModel(sessionID);
  const agent = getSessionOriginalAgent(sessionID);

  await abortSession(sessionID, context);

  if (currentModel && backoffLevel <= config.maxRetries) {
    const waitMs = BACKOFF_BASE_MS * 2 ** (backoffLevel - 1);
    await logger.info(`Backoff retry ${backoffLevel}/${config.maxRetries} (${waitMs}ms)`, {
      sessionID,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const ok = await fallbackToModel(
      sessionID,
      agent,
      currentModel,
      { providerID: currentModel.providerID, modelID: currentModel.modelID },
      "Retry attempt",
      logger,
      context,
    );
    if (ok) {
      await logger.info("Retry succeeded with same model", {
        sessionID,
        backoffLevel,
      });
      return;
    }
  }

  resetBackoff(sessionID);
  if (!currentModel) {
    await logger.warn("No current model available, going straight to fallback chain", {
      sessionID,
    });
  } else {
    await logger.info(`Retries exhausted (${backoffLevel}), starting fallback chain`, {
      sessionID,
    });
  }
  const chain = await getValidatedFallbackChain(config, agent, sessionID, logger);
  if (chain.length === 0) return;
  await tryFallbackChain(
    sessionID,
    chain,
    agent,
    currentModel ?? null,
    "Retries exhausted",
    logger,
    context,
  );
}

export async function handleImmediate(
  sessionID: string,
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
): Promise<void> {
  const phase = getLargeContextPhase(sessionID);
  if (phase === "active" || phase === "pending" || phase === "summarizing") {
    await logger.info("Skipping fallback — large context phase active", {
      sessionID,
      phase,
    });
    return;
  }

  activateCooldown(sessionID, config.cooldownMs);
  const currentModel = getCurrentModel(sessionID);
  const agent = getSessionOriginalAgent(sessionID);

  if (currentModel) {
    markModelCooldown(currentModel.providerID, currentModel.modelID, config.cooldownMs);
    setSessionCooldownModel(sessionID, currentModel.providerID, currentModel.modelID);
    await logger.info(`Model ${formatModelKey(currentModel)} in cooldown`, {
      sessionID,
    });
  }

  await abortSession(sessionID, context);
  deleteLargeContextPhase(sessionID);
  const chain = await getValidatedFallbackChain(config, agent, sessionID, logger);
  await logger.info(`Immediate fallback chain (${chain.length} models)`, {
    sessionID,
  });
  if (chain.length === 0) return;
  await tryFallbackChain(
    sessionID,
    chain,
    agent,
    currentModel ?? null,
    "Immediate fallback",
    logger,
    context,
  );
}

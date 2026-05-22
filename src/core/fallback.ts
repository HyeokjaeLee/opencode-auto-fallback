import { getFallbackChain } from "@/config/config";
import { BACKOFF_BASE_MS, LARGE_CONTEXT_CONTINUATION, TOAST_DURATION_MS } from "@/config/constants";
import type { FallbackConfig, FallbackModel } from "@/config/types";
import {
  deleteLargeContextPhase,
  getCurrentModel,
  getSessionOriginalAgent,
  setActiveFallbackParams,
  setSessionCooldownModel,
} from "@/state/context-state";
import { isModelInCooldown, markModelCooldown } from "@/state/provider-state";
import { activateCooldown, incrementBackoff, resetBackoff } from "@/state/session-state";
import { serializeError } from "@/utils/error";
import { formatModelKey } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSession, showToastSafely } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function fallbackToModel(
  sessionID: string,
  agent: string | undefined,
  model: FallbackModel,
  logger: Logger,
  context: PluginInput,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, model);
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        agent,
        parts: [{ type: "text", text: LARGE_CONTEXT_CONTINUATION }],
        ...(model.variant ? { variant: model.variant } : {}),
      },
    });
    return true;
  } catch (err) {
    await logger.warn("Fallback prompt failed", {
      sessionID,
      model,
      error: serializeError(err),
    });
    return false;
  }
}

export async function getValidatedFallbackChain(
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
    if (await fallbackToModel(sessionID, agent, chain[i], logger, context)) {
      await logger.info("Fallback chain succeeded", {
        sessionID,
        triedCount: i + 1,
      });
      await showToastSafely(
        context,
        {
          title: "Model Fallback",
          message: `Switched to ${formatModelKey(chain[i])}`,
          variant: "info",
          duration: TOAST_DURATION_MS,
        },
        logger,
      );
      return true;
    }
  }
  await showToastSafely(
    context,
    {
      title: "Fallback Failed",
      message: "All fallback models exhausted",
      variant: "error",
      duration: TOAST_DURATION_MS,
    },
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
  const backoffLevel = incrementBackoff(sessionID);
  const currentModel = getCurrentModel(sessionID);
  const agent = getSessionOriginalAgent(sessionID);

  await abortSession(sessionID, context);

  if (currentModel && backoffLevel <= config.maxRetries) {
    const waitMs = BACKOFF_BASE_MS * Math.pow(2, backoffLevel - 1);
    await logger.info(`Backoff retry ${backoffLevel}/${config.maxRetries} (${waitMs}ms)`, {
      sessionID,
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const ok = await fallbackToModel(
      sessionID,
      agent,
      { providerID: currentModel.providerID, modelID: currentModel.modelID },
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
    await showToastSafely(
      context,
      {
        title: "Retries Exhausted",
        message: `Switching to fallback after ${config.maxRetries} retries`,
        variant: "warning",
        duration: TOAST_DURATION_MS,
      },
      logger,
    );
    await logger.info(`Retries exhausted (${backoffLevel}), starting fallback chain`, {
      sessionID,
    });
  }
  const chain = await getValidatedFallbackChain(config, agent, sessionID, logger);
  if (chain.length === 0) return;
  await tryFallbackChain(sessionID, chain, agent, logger, context);
}

export async function handleImmediate(
  sessionID: string,
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
): Promise<void> {
  activateCooldown(sessionID, config.cooldownMs);
  const currentModel = getCurrentModel(sessionID);
  const agent = getSessionOriginalAgent(sessionID);

  if (currentModel) {
    markModelCooldown(currentModel.providerID, currentModel.modelID, config.cooldownMs);
    setSessionCooldownModel(sessionID, currentModel.providerID, currentModel.modelID);
    await showToastSafely(
      context,
      {
        title: "Model Error",
        message: `${formatModelKey(currentModel)} failed, switching to fallback`,
        variant: "warning",
        duration: TOAST_DURATION_MS,
      },
      logger,
    );
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
  await tryFallbackChain(sessionID, chain, agent, logger, context);
}

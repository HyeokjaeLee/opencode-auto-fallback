import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig, FallbackModel } from "./types";
import {
  BACKOFF_BASE_MS,
  REVERT_DELAY_MS,
  TOAST_DURATION_MS,
} from "./constants";
import { getFallbackChain } from "./config";
import { isModelInCooldown } from "./provider-state";
import {
  setActiveFallbackParams,
  setSessionCooldownModel,
  deleteLargeContextPhase,
} from "./state/context-state";
import { markModelCooldown } from "./provider-state";
import {
  incrementBackoff,
  resetBackoff,
  activateCooldown,
} from "./session-state";
import type { Logger, ChatMessageInput } from "./session-utils";
import { showToastSafely, abortSession, fetchSessionData } from "./session-utils";
import type { PromptPart } from "./message";

export async function revertAndPrompt(
  sessionID: string,
  agent: string | undefined,
  parts: PromptPart[],
  messageID: string,
  model: FallbackModel,
  logger: Logger,
  context: PluginInput,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, model);
    await context.client.session.revert({
      path: { id: sessionID },
      body: { messageID },
    });
    await new Promise((resolve) => setTimeout(resolve, REVERT_DELAY_MS));
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        agent,
        parts,
        ...(model.variant ? { variant: model.variant } : {}),
      },
    });
    return true;
  } catch (err) {
    await logger.warn("Prompt failed", {
      sessionID,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function tryFallbackChain(
  sessionID: string,
  chain: FallbackModel[],
  agent: string | undefined,
  parts: PromptPart[],
  messageID: string,
  logger: Logger,
  context: PluginInput,
): Promise<boolean> {
  for (let i = 0; i < chain.length; i++) {
    if (isModelInCooldown(chain[i].providerID, chain[i].modelID)) {
      await logger.info(
        `Skipping model in cooldown ${chain[i].providerID}/${chain[i].modelID}`,
        {
          sessionID,
          model: chain[i],
          remaining: chain.length - i - 1,
        },
      );
      continue;
    }
    await logger.info(`Trying fallback ${i + 1}/${chain.length}`, {
      sessionID,
      model: chain[i],
    });
    if (
      await revertAndPrompt(
        sessionID,
        agent,
        parts,
        messageID,
        chain[i],
        logger,
        context,
      )
    ) {
      await logger.info("Fallback chain succeeded", {
        sessionID,
        triedCount: i + 1,
      });
      await showToastSafely(
        context,
        {
          title: "Model Fallback",
          message: `Switched to ${chain[i].providerID}/${chain[i].modelID}`,
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
  hookInput?: ChatMessageInput,
) {
  const backoffLevel = incrementBackoff(sessionID);
  const { extracted, currentModel } = await fetchSessionData(
    sessionID,
    context,
    logger,
    hookInput,
  );
  if (!extracted) {
    await logger.error("Cannot retry: missing user message", { sessionID });
    return;
  }

  await abortSession(sessionID, context);

  if (currentModel && backoffLevel <= config.maxRetries) {
    const waitMs = BACKOFF_BASE_MS * Math.pow(2, backoffLevel - 1);
    await logger.info(
      `Backoff retry ${backoffLevel}/${config.maxRetries} (${waitMs}ms)`,
      { sessionID },
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const ok = await revertAndPrompt(
      sessionID,
      extracted.info.agent,
      extracted.parts,
      extracted.info.id,
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
    await logger.warn(
      "No current model available, going straight to fallback chain",
      { sessionID },
    );
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
    await logger.info(
      `Retries exhausted (${backoffLevel}), starting fallback chain`,
      { sessionID },
    );
  }
  const chain = getFallbackChain(config, extracted.info.agent);
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", {
      sessionID,
      agent: extracted.info.agent,
    });
    return;
  }
  await tryFallbackChain(
    sessionID,
    chain,
    extracted.info.agent,
    extracted.parts,
    extracted.info.id,
    logger,
    context,
  );
}

export async function handleImmediate(
  sessionID: string,
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  hookInput?: ChatMessageInput,
) {
  activateCooldown(sessionID, config.cooldownMs);
  const { extracted, currentModel } = await fetchSessionData(
    sessionID,
    context,
    logger,
    hookInput,
  );

  if (currentModel) {
    markModelCooldown(
      currentModel.providerID,
      currentModel.modelID,
      config.cooldownMs,
    );
    setSessionCooldownModel(
      sessionID,
      currentModel.providerID,
      currentModel.modelID,
    );
    await showToastSafely(
      context,
      {
        title: "Model Error",
        message: `${currentModel.providerID}/${currentModel.modelID} failed, switching to fallback`,
        variant: "warning",
        duration: TOAST_DURATION_MS,
      },
      logger,
    );
    await logger.info(
      `Model ${currentModel.providerID}/${currentModel.modelID} in cooldown`,
      { sessionID },
    );
  }

  if (!extracted) {
    await logger.error("Cannot fallback: no valid user message", { sessionID });
    return;
  }

  await abortSession(sessionID, context);
  deleteLargeContextPhase(sessionID);
  const chain = getFallbackChain(config, extracted.info.agent);
  await logger.info(`Immediate fallback chain (${chain.length} models)`, {
    sessionID,
  });
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", {
      sessionID,
      agent: extracted.info.agent,
    });
    return;
  }
  await tryFallbackChain(
    sessionID,
    chain,
    extracted.info.agent,
    extracted.parts,
    extracted.info.id,
    logger,
    context,
  );
}

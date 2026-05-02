import type { Hooks, PluginInput } from "@opencode-ai/plugin";

type PluginHooks = Hooks & {
  "experimental.compaction.autocontinue"?: (
    input: {
      sessionID: string;
      agent: string;
      model?: { providerID: string; modelID: string };
    },
    output: { enabled: boolean },
  ) => Promise<void>;
};

import type { FallbackConfig } from "./types";
import {
  TOAST_DURATION_MS,
  TOAST_DURATION_LONG_MS,
  COMPACTION_FALLBACK_TOKEN_LIMIT,
} from "./constants";
import { normalizeAgentName, parseModel } from "./config";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { deactivateCooldown } from "./session-state";
import {
  getAndClearFallbackParams,
  setCurrentModel,
  hasModelChanged,
  getOrSetOriginalModel,
  getLargeContextPhase,
  deleteLargeContextPhase,
  deleteRestoreModel,
  setModelContextLimit,
  setModelLimit,
  getModelContextLimit,
  setSessionOriginalAgent,
  getSessionOriginalAgent,
  isRegisteredAgent,
  setRegisteredAgents,
  setCompactionReserved,
  deleteSessionCooldownModel,
  getAndClearCompactionTarget,
  getRestoreModel,
  getOriginalModel,
  getCurrentModel,
  setLargeContextPhase,
} from "./state/context-state";
import { checkForUpdates, tryInstallUpdate } from "./update-checker";
import { version as currentVersion } from "../package.json";
import type { Logger } from "./session-utils";
import { showToastSafely } from "./session-utils";
import { checkContextThreshold } from "./large-context";
import { createEventHandler } from "./hooks/events";

export async function createPlugin(context: PluginInput): Promise<PluginHooks> {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agentFallbacks: config.agentFallbacks,
    maxRetries: config.maxRetries,
    cooldownMs: config.cooldownMs,
  });

  if (!config.enabled) {
    await logger.info("Plugin disabled via config");
    return {};
  }

  checkForUpdates(currentVersion)
    .then(async (info) => {
      if (!info.hasUpdate) return;

      await logger.info(`Update available: ${info.current} → ${info.latest}`);
      await showToastSafely(
        context,
        {
          title: "Updating Plugin",
          message: `opencode-auto-fallback ${info.current} → ${info.latest}`,
          variant: "info",
          duration: TOAST_DURATION_MS,
        },
        logger,
      );

      const ok = await tryInstallUpdate(info.latest);
      if (ok) {
        await logger.info(`Updated to ${info.latest}`);
        await showToastSafely(
          context,
          {
            title: "Plugin Updated",
            message: `opencode-auto-fallback updated to ${info.latest}`,
            variant: "success",
            duration: TOAST_DURATION_MS,
          },
          logger,
        );
      } else {
        await logger.warn("Auto-update failed");
        await showToastSafely(
          context,
          {
            title: "Update Failed",
            message: `Could not auto-update. Run manually: bun update opencode-auto-fallback`,
            variant: "warning",
            duration: TOAST_DURATION_LONG_MS,
          },
          logger,
        );
      }
    })
    .catch(async (err) => {
      await logger.warn("Update check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    config: async (input) => {
      const lcf = config.largeContextFallback;
      if (!lcf) return;
      setRegisteredAgents(lcf.agents.map((a) => normalizeAgentName(a)));
      const existingCompaction = (input as Record<string, unknown>).compaction as { reserved?: number; auto?: boolean } | undefined;
      if (existingCompaction?.reserved !== undefined) {
        setCompactionReserved(existingCompaction.reserved);
        await logger.info("Config: captured compaction.reserved", {
          reserved: existingCompaction.reserved,
        });
      }
      const compaction = existingCompaction || {};
      (input as Record<string, unknown>).compaction = compaction;
      compaction.auto = false;
      await logger.info(
        "Config: auto-compaction globally disabled (SDK limitation: no per-agent setting)",
        {
          agents: lcf.agents,
          largeModel: lcf.model,
        },
      );
    },

    "chat.params": createChatParamsHandler(config, logger, context),

    "experimental.session.compacting": createCompactingHandler(config, logger),

    "experimental.compaction.autocontinue": createAutocontinueHandler(logger),

    event: createEventHandler(config, logger, context),
  };
}

function createChatParamsHandler(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
) {
  return async (input: any, output: any) => {
    if (
      input.agent &&
      isRegisteredAgent(input.agent) &&
      !getSessionOriginalAgent(input.sessionID)
    ) {
      setSessionOriginalAgent(input.sessionID, input.agent);
    }

    if (input.model) {
      const { changed, previous: prev } = hasModelChanged(
        input.sessionID,
        input.model.providerID,
        input.model.id,
      );

      setCurrentModel(
        input.sessionID,
        input.model.providerID,
        input.model.id,
      );

      if (changed) {
        deactivateCooldown(input.sessionID);
        deleteSessionCooldownModel(input.sessionID);
        await logger.info("Model changed, cooldown reset", {
          sessionID: input.sessionID,
          model: `${input.model.providerID}/${input.model.id}`,
          previousModel: prev ? `${prev.providerID}/${prev.modelID}` : "none",
        });

        const lcf = config.largeContextFallback;
        if (lcf && prev) {
          const lcfParsed = parseModel(lcf.model);
          const phase = getLargeContextPhase(input.sessionID);
          if (
            (phase === "active" || phase === "pending") &&
            prev.providerID === lcfParsed.providerID &&
            prev.modelID === lcfParsed.modelID &&
            (input.model.providerID !== lcfParsed.providerID ||
              input.model.id !== lcfParsed.modelID)
          ) {
            deleteLargeContextPhase(input.sessionID);
            deleteRestoreModel(input.sessionID);
            await logger.info("Model changed from large model, phase reset", {
              sessionID: input.sessionID,
              fromModel: `${prev.providerID}/${prev.modelID}`,
              toModel: `${input.model.providerID}/${input.model.id}`,
              previousPhase: phase,
            });
          }
        }
      }

      getOrSetOriginalModel(
        input.sessionID,
        input.model.providerID,
        input.model.id,
      );

      const ctxLimit = input.model.limit.context;
      if (ctxLimit !== undefined) {
        const modelKey = `${input.model.providerID}/${input.model.id}`;
        setModelContextLimit(modelKey, ctxLimit);
        const rawLimit = input.model.limit as {
          context: number;
          input?: number;
          output: number;
        };
        if (rawLimit.input !== undefined)
          setModelLimit(modelKey, "input", rawLimit.input);
        setModelLimit(modelKey, "output", rawLimit.output);
        if (changed) {
          await logger.info("Detected model context limit", {
            sessionID: input.sessionID,
            model: modelKey,
            contextLimit: ctxLimit,
          });
        }
      }

      // Pre-fetch large context fallback model limit
      const lcf = config.largeContextFallback;
      if (lcf) {
        const lcfParsed = parseModel(lcf.model);
        const lcfKey = `${lcfParsed.providerID}/${lcfParsed.modelID}`;
        if (
          !getModelContextLimit(lcfKey) &&
          lcfParsed.providerID === input.model.providerID &&
          input.provider.info?.models
        ) {
          const largeModel = input.provider.info.models[lcfParsed.modelID];
          if (largeModel?.limit?.context) {
            setModelContextLimit(lcfKey, largeModel.limit.context);
            await logger.info(
              "Pre-fetched large context fallback model limit",
              {
                sessionID: input.sessionID,
                model: lcfKey,
                contextLimit: largeModel.limit.context,
              },
            );
          }
        }
      }
    }

    // Pre-generation context threshold check
    if (!getLargeContextPhase(input.sessionID)) {
      const lcf = config.largeContextFallback;
      if (lcf && input.agent && isRegisteredAgent(input.agent)) {
        const threshold = await checkContextThreshold(
          input.sessionID,
          context,
          logger,
        );
        if (threshold.atThreshold) {
          await logger.info("Pre-generation threshold exceeded, aborting", {
            sessionID: input.sessionID,
            usage: threshold.usage,
            limit: threshold.limit,
          });
          try {
            await context.client.session.abort({
              path: { id: input.sessionID },
            });
            await new Promise((resolve) =>
              setTimeout(resolve, 300),
            );
          } catch {
            /* session may already be idle */
          }
          return;
        }
      }
    }

    const fallback = getAndClearFallbackParams(input.sessionID);
    if (!fallback) return;
    await logger.info("Applying fallback model params", {
      sessionID: input.sessionID,
      model: `${fallback.providerID}/${fallback.modelID}`,
      temperature: fallback.temperature,
      topP: fallback.topP,
      reasoningEffort: fallback.reasoningEffort,
      maxTokens: fallback.maxTokens,
    });
    if (fallback.temperature !== undefined)
      output.temperature = fallback.temperature;
    if (fallback.topP !== undefined) output.topP = fallback.topP;
    if (fallback.reasoningEffort !== undefined) {
      output.options.reasoningEffort = fallback.reasoningEffort;
    }
    if (fallback.maxTokens !== undefined) {
      output.options.maxTokens = fallback.maxTokens;
    }
    if (fallback.thinking !== undefined) {
      output.options.thinking = fallback.thinking;
    }
  };
}

function createCompactingHandler(
  _config: FallbackConfig,
  logger: Logger,
) {
  return async (input: any, output: any) => {
    const phase = getLargeContextPhase(input.sessionID);

    // Summarizing for switch-back
    if (phase === "summarizing") {
      const original =
        getRestoreModel(input.sessionID) ?? getOriginalModel(input.sessionID);
      if (original) {
        const originalLimit = getModelContextLimit(
          `${original.providerID}/${original.modelID}`,
        );
        const targetTokens = originalLimit
          ? Math.floor(originalLimit * 0.2)
          : COMPACTION_FALLBACK_TOKEN_LIMIT;
        output.context.push(`Reduce to at most ${targetTokens} tokens.`);
        await logger.info(
          "Compacting: summarizing — appended original model context",
          {
            sessionID: input.sessionID,
            originalModel: `${original.providerID}/${original.modelID}`,
            originalLimit,
            targetTokens,
          },
        );
      }
      return;
    }

    // Active phase: self-compaction or manual /compact
    if (phase === "active") {
      const target = getAndClearCompactionTarget(input.sessionID);
      if (target === "large") {
        const curModel = getCurrentModel(input.sessionID);
        const largeLimit = curModel
          ? getModelContextLimit(`${curModel.providerID}/${curModel.modelID}`)
          : undefined;
        output.context.push(
          largeLimit
            ? `The session is running on a large context model with ${largeLimit} token capacity. Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`
            : `Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`,
        );
        await logger.info(
          "Compacting: large model self-compaction — appended",
          { sessionID: input.sessionID, largeLimit },
        );
      } else {
        const original =
          getRestoreModel(input.sessionID) ??
          getOriginalModel(input.sessionID);
        if (original) {
          const originalLimit = getModelContextLimit(
            `${original.providerID}/${original.modelID}`,
          );
          output.context.push(
            originalLimit
              ? `The compacted summary must fit within ${originalLimit} tokens because the session will return to the original model (${original.providerID}/${original.modelID}). Produce a concise summary preserving only: the user's original request, key files changed, critical decisions, and current status. Discard verbatim conversation.`
              : `The session will return to the original model (${original.providerID}/${original.modelID}) after compaction. Produce a concise summary preserving: user request, key files, decisions, and status. Discard verbatim conversation.`,
          );
          await logger.info(
            "Compacting: /compact — appended original model context",
            {
              sessionID: input.sessionID,
              originalModel: `${original.providerID}/${original.modelID}`,
              originalLimit,
            },
          );
        }
        setLargeContextPhase(input.sessionID, "summarizing");
      }
      return;
    }

    // Non-registered agent — use default
    const agent = getSessionOriginalAgent(input.sessionID);
    if (agent && !isRegisteredAgent(agent)) {
      await logger.info("Compacting: non-registered agent, using default", {
        sessionID: input.sessionID,
      });
      return;
    }
  };
}

function createAutocontinueHandler(logger: Logger) {
  return async (
    input: { sessionID: string; agent: string },
    output: { enabled: boolean },
  ) => {
    const phase = getLargeContextPhase(input.sessionID);
    if (phase === "pending") {
      output.enabled = false;
      await logger.info("Autocontinue: suppressed (phase=pending)", {
        sessionID: input.sessionID,
      });
      return;
    }
    if (phase === "active" || phase === "summarizing") {
      output.enabled = true;
      await logger.info("Autocontinue: enabled (large context phase)", {
        sessionID: input.sessionID,
        phase,
      });
    }
  };
}


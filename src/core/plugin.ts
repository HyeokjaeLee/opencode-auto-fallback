import {
  getAgentLargeContextModel,
  getAgentMinContextRatio,
  getLargeContextEligibleAgentNames,
  getRegisteredAgentNames,
  loadConfig,
} from "@/config/config";
import {
  COMPACTION_FALLBACK_TOKEN_LIMIT,
  TOAST_DURATION_LONG_MS,
  TOAST_DURATION_MS,
} from "@/config/constants";
import type { FallbackConfig } from "@/config/types";
import { handleLargeContextSwitch, shouldSkipLargeContextFallback } from "@/core/large-context";
import { createEventHandler } from "@/hooks/events";
import {
  deleteSessionCooldownModel,
  getAndClearCompactionTarget,
  getAndClearFallbackParams,
  getCurrentModel,
  getLargeContextPhase,
  getModelContextLimit,
  getOrSetOriginalModel,
  getRecoveryModel,
  getSessionOriginalAgent,
  hasModelChanged,
  isRegisteredAgent,
  setCurrentModel,
  setModelContextLimit,
  setModelInputLimit,
  setOpencodeCompacting,
  setRegisteredAgents,
  setLargeContextEligibleAgents,
  setSessionOriginalAgent,
  setCompactionTarget,
  setRestoreModel,
  clearReturnDeferred,
  isSyntheticPromptActive,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { deactivateCooldown } from "@/state/session-state";
import { checkContextThreshold } from "@/utils/context";
import { serializeError } from "@/utils/error";
import { createLogger } from "@/utils/log";
import { formatModelKey, isSameModel } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSessionSafely, showToastSafely } from "@/utils/session-utils";
import { isSubagentSession, prepareSessionForPrompt } from "@/utils/subagent";
import { checkForUpdates, tryInstallUpdate } from "@/utils/update-checker";
import { version as currentVersion } from "~/package.json";

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

interface ChatParamsModel {
  providerID: string;
  id: string;
  limit: {
    context: number | undefined;
    input?: number;
    output: number;
  };
}

interface ChatParamsInput {
  agent?: string;
  sessionID: string;
  model?: ChatParamsModel;
  provider: {
    info?: {
      models?: Record<
        string,
        {
          limit?: { context?: number };
        }
      >;
    };
  };
}

interface ChatParamsOutput {
  temperature?: number;
  topP?: number;
  options: {
    reasoningEffort?: string;
    maxTokens?: number;
    thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
  };
}

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
}

export async function createPlugin(context: PluginInput): Promise<PluginHooks> {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agents: Object.keys(config.agents),
    maxRetries: config.maxRetries,
    cooldownMs: config.cooldownMs,
  });

  if (!config.enabled) {
    await logger.info("Plugin disabled via config");
    return {};
  }

  if (config.autoUpdate) {
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
          await logger.info(`Updated to ${info.latest}. Restart opencode to apply.`);
          await showToastSafely(
            context,
            {
              title: "Plugin Updated",
              message: `opencode-auto-fallback updated to ${info.latest}. Restart opencode to apply.`,
              variant: "success",
              duration: TOAST_DURATION_LONG_MS,
            },
            logger,
          );
        } else {
          await logger.warn(`Auto-update failed. Run manually: bun update opencode-auto-fallback`);
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
          error: serializeError(err),
        });
      });
  }

  return {
    config: async (input) => {
      // Always sync the registry — even to [] — so stale state cannot survive a config change.
      const registeredNames = getRegisteredAgentNames(config);
      setRegisteredAgents(registeredNames);

      // Native auto-compaction is only sacrificed when a large-context agent needs
      // the plugin-managed switch; fallback-only setups keep opencode's own compaction.
      const eligibleNames = getLargeContextEligibleAgentNames(config);
      setLargeContextEligibleAgents(eligibleNames);
      if (eligibleNames.length === 0) return;

      const existingCompaction = (input as Record<string, unknown>).compaction as
        | { reserved?: number; auto?: boolean }
        | undefined;
      const compaction = existingCompaction ?? {};
      (input as Record<string, unknown>).compaction = compaction;
      compaction.auto = false;
      await logger.info(
        "Config: auto-compaction globally disabled (SDK limitation: no per-agent setting)",
        {
          eligibleAgents: eligibleNames,
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
): (input: ChatParamsInput, output: ChatParamsOutput) => Promise<void> {
  return async (input: ChatParamsInput, output: ChatParamsOutput): Promise<void> => {
    // Record the agent for ANY session so fallback re-sends keep the original agent,
    // even in default-only configs where no agent is registered (issue #3).
    if (input.agent && !getSessionOriginalAgent(input.sessionID)) {
      setSessionOriginalAgent(input.sessionID, input.agent);
    }

    if (!isSyntheticPromptActive(input.sessionID)) {
      clearReturnDeferred(input.sessionID);
    }

    if (input.model) {
      const { changed, previous: prev } = hasModelChanged(
        input.sessionID,
        input.model.providerID,
        input.model.id,
      );

      setCurrentModel(input.sessionID, input.model.providerID, input.model.id);

      const ctxLimit = input.model.limit.context;
      if (ctxLimit !== undefined) {
        const modelKey = formatModelKey({
          providerID: input.model.providerID,
          modelID: input.model.id,
        });
        setModelContextLimit(modelKey, ctxLimit);
        const rawLimit = input.model.limit as {
          context: number;
          input?: number;
        };
        if (rawLimit.input !== undefined) setModelInputLimit(modelKey, rawLimit.input);
      }

      if (changed) {
        deactivateCooldown(input.sessionID);
        deleteSessionCooldownModel(input.sessionID);
        await logger.info("Model changed, cooldown reset", {
          sessionID: input.sessionID,
          model: formatModelKey({ providerID: input.model.providerID, modelID: input.model.id }),
          previousModel: prev ? formatModelKey(prev) : "none",
        });

        if (prev) {
          const agent = getSessionOriginalAgent(input.sessionID) ?? input.agent;
          if (agent && isRegisteredAgent(agent)) {
            const lcfParsed = getAgentLargeContextModel(config, agent);
            const phase = getLargeContextPhase(input.sessionID);
            if (
              lcfParsed &&
              (phase === "active" || phase === "pending") &&
              isSameModel(prev, lcfParsed) &&
              !isSameModel(
                { providerID: input.model.providerID, modelID: input.model.id },
                lcfParsed,
              )
            ) {
              await logger.info("Model changed from large model, restarting generation", {
                sessionID: input.sessionID,
                fromModel: formatModelKey(prev),
                toModel: formatModelKey({
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                }),
                phase,
              });
              setRestoreModel(input.sessionID, input.model.providerID, input.model.id);
              // Child/unknown-ownership sessions are never aborted here (issue #4).
              const recovery = await prepareSessionForPrompt(input.sessionID, context, logger);
              if (recovery === "not-ready") {
                await logger.warn("Model changed from large model, but session not ready", {
                  sessionID: input.sessionID,
                });
              }
              return;
            }
          }
        }
      }

      getOrSetOriginalModel(input.sessionID, input.model.providerID, input.model.id);

      if (ctxLimit !== undefined && changed) {
        const modelKey = formatModelKey({
          providerID: input.model.providerID,
          modelID: input.model.id,
        });
        await logger.info("Detected model context limit", {
          sessionID: input.sessionID,
          model: modelKey,
          contextLimit: ctxLimit,
        });
      }

      const agent = getSessionOriginalAgent(input.sessionID) ?? input.agent;
      if (agent && isRegisteredAgent(agent)) {
        const lcfParsed = getAgentLargeContextModel(config, agent);
        if (lcfParsed) {
          const lcfKey = formatModelKey(lcfParsed);
          if (
            !getModelContextLimit(lcfKey) &&
            lcfParsed.providerID === input.model.providerID &&
            input.provider.info?.models
          ) {
            const largeModel = input.provider.info.models[lcfParsed.modelID];
            if (largeModel.limit?.context) {
              setModelContextLimit(lcfKey, largeModel.limit.context);
              await logger.info("Pre-fetched large context fallback model limit", {
                sessionID: input.sessionID,
                model: lcfKey,
                contextLimit: largeModel.limit.context,
              });
            }
          }
        }
      }
    }
    if (!getLargeContextPhase(input.sessionID)) {
      if (input.agent) {
        const threshold = await checkContextThreshold(input.sessionID, context, logger);
        if (threshold.atThreshold) {
          // Aborting a task-tool child session cancels its parent's task call
          // (issue #4) — leave children and unknown-ownership sessions alone here.
          const isChild = await isSubagentSession(input.sessionID, context, logger);
          if (isChild === false) {
            const agent = getSessionOriginalAgent(input.sessionID) ?? input.agent;
            const lcfParsed = getAgentLargeContextModel(config, agent);
            const curModel = getCurrentModel(input.sessionID);
            const largeLimit = lcfParsed
              ? getModelContextLimit(formatModelKey(lcfParsed))
              : undefined;
            const minRatio = getAgentMinContextRatio(config, agent);
            // An unknown large-model limit does not fail the ratio gate (idle-handler convention).
            const canSwitch = Boolean(
              lcfParsed &&
              agent &&
              isRegisteredAgent(agent) &&
              curModel &&
              !isSameModel(curModel, lcfParsed) &&
              !isModelInCooldown(lcfParsed.providerID, lcfParsed.modelID) &&
              (!largeLimit ||
                !shouldSkipLargeContextFallback(threshold.limit, largeLimit, minRatio)),
            );

            if (canSwitch && lcfParsed) {
              await logger.info("Pre-generation: context at threshold, switching to large model", {
                sessionID: input.sessionID,
                usage: threshold.usage,
                limit: threshold.limit,
                largeModel: formatModelKey(lcfParsed),
              });
              await abortSessionSafely(input.sessionID, context);
              const switched = await handleLargeContextSwitch(
                input.sessionID,
                lcfParsed,
                context,
                logger,
                `Context at ${((threshold.usage / threshold.limit) * 100).toFixed(1)}%`,
              );
              if (!switched) {
                await logger.warn(
                  "Pre-generation: large context switch failed, session aborted at threshold",
                  { sessionID: input.sessionID },
                );
              }
              return;
            }

            await logger.info("Pre-generation: context at threshold, aborting", {
              sessionID: input.sessionID,
              usage: threshold.usage,
              limit: threshold.limit,
              atThreshold: threshold.atThreshold,
            });
            await abortSessionSafely(input.sessionID, context);
            return;
          }
          await logger.info(
            "Pre-generation: context at threshold, deferring to idle/error recovery (subagent session)",
            {
              sessionID: input.sessionID,
            },
          );
        }
      }
    }

    const fallback = getAndClearFallbackParams(input.sessionID);
    if (!fallback) return;
    await logger.info("Applying fallback model params", {
      sessionID: input.sessionID,
      model: formatModelKey(fallback),
      temperature: fallback.temperature,
      topP: fallback.topP,
      reasoningEffort: fallback.reasoningEffort,
      maxTokens: fallback.maxTokens,
    });
    if (fallback.temperature !== undefined) output.temperature = fallback.temperature;
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
): (input: CompactingInput, output: CompactingOutput) => Promise<void> {
  return async (input: CompactingInput, output: CompactingOutput): Promise<void> => {
    const phase = getLargeContextPhase(input.sessionID);

    if (phase === "summarizing") {
      const original = getRecoveryModel(input.sessionID);
      if (original) {
        const originalLimit = getModelContextLimit(formatModelKey(original));
        const targetTokens = originalLimit
          ? Math.floor(originalLimit * 0.2)
          : COMPACTION_FALLBACK_TOKEN_LIMIT;
        output.context.push(
          `Reduce to at most ${targetTokens} tokens. Do NOT invoke any tools or function calls — produce only a plain text summary.`,
        );
        await logger.info("Compacting: summarizing — appended original model context", {
          sessionID: input.sessionID,
          originalModel: formatModelKey(original),
          originalLimit,
          targetTokens,
        });
      }
      return;
    }

    if (phase === "active") {
      const target = getAndClearCompactionTarget(input.sessionID);
      if (target === "large") {
        const curModel = getCurrentModel(input.sessionID);
        const largeLimit = curModel ? getModelContextLimit(formatModelKey(curModel)) : undefined;
        output.context.push(
          largeLimit
            ? `The session is running on a large context model with ${largeLimit} token capacity. Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`
            : `Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`,
        );
        await logger.info("Compacting: large model self-compaction — appended", {
          sessionID: input.sessionID,
          largeLimit,
        });
      } else {
        setCompactionTarget(input.sessionID, "default");
        setOpencodeCompacting(input.sessionID);
        await logger.info(
          "Compacting: manual/internal compact during active phase — marked default",
          {
            sessionID: input.sessionID,
          },
        );
      }
      return;
    }

    const agent = getSessionOriginalAgent(input.sessionID);
    if (agent && !isRegisteredAgent(agent)) {
      await logger.info("Compacting: non-registered agent, using default", {
        sessionID: input.sessionID,
      });
    }
  };
}

function createAutocontinueHandler(
  logger: Logger,
): (input: { sessionID: string; agent: string }, output: { enabled: boolean }) => Promise<void> {
  return async (input: { sessionID: string; agent: string }, output: { enabled: boolean }) => {
    const phase = getLargeContextPhase(input.sessionID);
    if (phase === "pending") {
      output.enabled = false;
      await logger.info("Autocontinue: suppressed (phase=pending)", {
        sessionID: input.sessionID,
      });
      return;
    }
    if (phase === "active") {
      output.enabled = true;
      await logger.info("Autocontinue: enabled (large context phase active)", {
        sessionID: input.sessionID,
        phase,
      });
      return;
    }
    if (phase === "summarizing") {
      output.enabled = false;
      await logger.info(
        "Autocontinue: suppressed (phase=summarizing, waiting for compacted event)",
        {
          sessionID: input.sessionID,
        },
      );
    }
  };
}

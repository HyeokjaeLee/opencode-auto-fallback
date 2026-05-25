import {
  findConfigMismatches,
  getAgentLargeContextModel,
  getConfigDir,
  getRegisteredAgentNames,
  loadConfig,
  normalizeAgentName,
} from "@/config/config";
import {
  COMPACTION_FALLBACK_TOKEN_LIMIT,
  TOAST_DURATION_LONG_MS,
  TOAST_DURATION_MS,
} from "@/config/constants";
import type { FallbackConfig } from "@/config/types";
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
  setCompactionReserved,
  setCurrentModel,
  setLargeContextPhase,
  setModelContextLimit,
  setModelLimit,
  setRegisteredAgents,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { deactivateCooldown } from "@/state/session-state";
import { checkContextThreshold } from "@/utils/context";
import { serializeError } from "@/utils/error";
import { createLogger } from "@/utils/log";
import { formatModelKey, isSameModel } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { abortSessionSafely, showToastSafely } from "@/utils/session-utils";
import { checkForUpdates, tryInstallUpdate } from "@/utils/update-checker";
import { version as currentVersion } from "~/package.json";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
          await logger.info(`Updated to ${info.latest}`);
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
          error: serializeError(err),
        });
      });
  }

  return {
    config: async (input) => {
      const registeredNames = getRegisteredAgentNames(config);
      if (registeredNames.length === 0) return;

      setRegisteredAgents(registeredNames);

      const existingCompaction = (input as Record<string, unknown>).compaction as
        | { reserved?: number; auto?: boolean }
        | undefined;
      if (existingCompaction?.reserved !== undefined) {
        setCompactionReserved(existingCompaction.reserved);
        await logger.info("Config: captured compaction.reserved", {
          reserved: existingCompaction.reserved,
        });
      }
      const compaction = existingCompaction ?? {};
      (input as Record<string, unknown>).compaction = compaction;
      compaction.auto = false;
      await logger.info(
        "Config: auto-compaction globally disabled (SDK limitation: no per-agent setting)",
        {
          registeredAgents: registeredNames,
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
  let configChecked = false;

  return async (input: ChatParamsInput, output: ChatParamsOutput): Promise<void> => {
    if (input.agent && !getSessionOriginalAgent(input.sessionID)) {
      setSessionOriginalAgent(input.sessionID, input.agent);
    }

    if (!configChecked && Object.keys(config.agents).length > 0) {
      configChecked = true;
      runConfigCheck(config, context, logger);
    }

    if (input.model) {
      const { changed, previous: prev } = hasModelChanged(
        input.sessionID,
        input.model.providerID,
        input.model.id,
      );

      setCurrentModel(input.sessionID, input.model.providerID, input.model.id);

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
              !isSameModel({ providerID: input.model.providerID, modelID: input.model.id }, lcfParsed)
            ) {
              await logger.info("Model changed from large model, aborting generation", {
                sessionID: input.sessionID,
                fromModel: formatModelKey(prev),
                toModel: formatModelKey({
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                }),
                phase,
              });
              await abortSessionSafely(input.sessionID, context);
              return;
            }
          }
        }
      }

      getOrSetOriginalModel(input.sessionID, input.model.providerID, input.model.id);

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
          output: number;
        };
        if (rawLimit.input !== undefined) setModelLimit(modelKey, "input", rawLimit.input);
        setModelLimit(modelKey, "output", rawLimit.output);
        if (changed) {
          await logger.info("Detected model context limit", {
            sessionID: input.sessionID,
            model: modelKey,
            contextLimit: ctxLimit,
          });
        }
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
          await logger.info("Pre-generation: context at threshold, aborting", {
            sessionID: input.sessionID,
            usage: threshold.usage,
            limit: threshold.limit,
            atThreshold: threshold.atThreshold,
          });
          await abortSessionSafely(input.sessionID, context);
          return;
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
        output.context.push(`Reduce to at most ${targetTokens} tokens.`);
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
        const original = getRecoveryModel(input.sessionID);
        if (original) {
          const originalLimit = getModelContextLimit(formatModelKey(original));
          output.context.push(
            originalLimit
              ? `The compacted summary must fit within ${originalLimit} tokens because the session will return to the original model (${formatModelKey(original)}). Produce a concise summary preserving only: the user's original request, key files changed, critical decisions, and current status. Discard verbatim conversation.`
              : `The session will return to the original model (${formatModelKey(original)}) after compaction. Produce a concise summary preserving: user request, key files, decisions, and status. Discard verbatim conversation.`,
          );
          await logger.info("Compacting: /compact — appended original model context", {
            sessionID: input.sessionID,
            originalModel: formatModelKey(original),
            originalLimit,
          });
        }
        setLargeContextPhase(input.sessionID, "summarizing");
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
    if (phase === "active" || phase === "summarizing") {
      output.enabled = true;
      await logger.info("Autocontinue: enabled (large context phase)", {
        sessionID: input.sessionID,
        phase,
      });
    }
  };
}

async function runConfigCheck(
  config: FallbackConfig,
  context: PluginInput,
  logger: Logger,
): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await logger.info("runConfigCheck: attempt", { attempt });

      const appClient = (context.client as unknown as Record<string, unknown>).app as
        | Record<string, unknown>
        | undefined;
      const agentsFn = appClient?.agents as (() => Promise<unknown>) | undefined;
      if (!agentsFn) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const agentsResult = await agentsFn();
      const opencodeAgents: string[] = Array.isArray(agentsResult)
        ? (agentsResult as Array<{ name: string }>).map((a) => a.name)
        : agentsResult &&
            typeof agentsResult === "object" &&
            Array.isArray((agentsResult as Record<string, unknown>).data)
          ? ((agentsResult as Record<string, unknown>).data as Array<{ name: string }>).map(
              (a) => a.name,
            )
          : [];

      await logger.info("runConfigCheck: agents fetched", {
        count: opencodeAgents.length,
        agents: opencodeAgents,
      });

      if (opencodeAgents.length === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const mismatches = findConfigMismatches(config, opencodeAgents);
      const hasIssues =
        mismatches.orphanedConfigKeys.length > 0 ||
        mismatches.uncoveredAgents.length > 0 ||
        mismatches.invalidModels.length > 0;

      if (!hasIssues) return;

    const logLines: string[] = ["Invalid values detected in fallback.json."];
    if (mismatches.orphanedConfigKeys.length > 0) {
      logLines.push(`Agents: [${mismatches.orphanedConfigKeys.join(", ")}]`);
    }
    if (mismatches.invalidModels.length > 0) {
      logLines.push(`Models: [${mismatches.invalidModels.join(", ")}]`);
    }
    logLines.push(
      `Allowed Agents: [${opencodeAgents.map((a) => normalizeAgentName(a)).join(", ")}]`,
    );

    const configDir = getConfigDir();
      const logPath = join(configDir, "invalid-fallback.log");
      try {
        writeFileSync(logPath, `${logLines.join("\n")}\n`, "utf-8");
      } catch {}

      await showToastSafely(
        context,
        {
          title: "Fallback Config Invalid",
          message: `fallback.json has invalid values. See: ${logPath}`,
          variant: "warning",
          duration: TOAST_DURATION_LONG_MS,
        },
        logger,
      );
      await logger.warn("Config mismatch detected", {
        orphanedConfigKeys: mismatches.orphanedConfigKeys,
        uncoveredAgents: mismatches.uncoveredAgents,
        invalidModels: mismatches.invalidModels,
        logPath,
      });
      return;
    } catch (err) {
      await logger.warn("runConfigCheck: attempt failed", {
        attempt,
        error: serializeError(err),
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await logger.warn("runConfigCheck: all attempts exhausted");
}

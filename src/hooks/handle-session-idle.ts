import { getAgentLargeContextModel, getAgentMinContextRatio } from "@/config/config";
import type { FallbackConfig } from "@/config/types";
import {
  handleLargeContextSwitch,
  handleLargeContextReturn,
  handleLargeContextCompletion,
  shouldSkipLargeContextFallback,
} from "@/core/large-context";
import {
  getCurrentModel,
  getLargeContextPhase,
  deleteLargeContextPhase,
  setCompactionTarget,
  clearCompactionTarget,
  getSessionOriginalAgent,
  isRegisteredAgent,
  hasRegisteredAgents,
  getModelContextLimit,
  setSessionOriginalAgent,
  getAndClearPendingConfigWarning,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { checkContextThreshold } from "@/utils/context";
import { formatModelKey, isSameModel } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";
import { fetchSessionData } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function handleSessionIdle(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { sessionID: string };
  const sessionID = props.sessionID;

  const pendingWarning = getAndClearPendingConfigWarning(sessionID);
  if (pendingWarning) {
    try {
      await context.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text" as const, text: pendingWarning, ignored: true }],
        },
      });
    } catch (err) {
      await logger.warn("Failed to send config warning", { error: String(err) });
    }
  }

  const phase = getLargeContextPhase(sessionID);
  let agent = getSessionOriginalAgent(sessionID);

  if (!agent || (agent && !isRegisteredAgent(agent))) {
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

  if (!phase) {
    if (!agent) return;

    // Non-registered agents (largeContextModel: false): auto-compaction is disabled
    // globally by the config hook, but this agent opted out of large context fallback.
    // Trigger manual compact as safety net when context is at threshold.
    // Only act when the plugin disabled auto-compaction (i.e. other agents have
    // largeContextModel set). If no agents use largeContextModel, opencode's
    // native compaction handles everything — don't double-compact.
    if (!isRegisteredAgent(agent)) {
      if (!hasRegisteredAgents()) return;

      const thresholdResult = await checkContextThreshold(props.sessionID, context, logger);
      if (thresholdResult.limit === 0 || !thresholdResult.atThreshold) return;

      const curModel = getCurrentModel(props.sessionID);
      await logger.info("Idle: non-registered agent at context limit, triggering manual compact", {
        sessionID: props.sessionID,
        agent,
        usage: thresholdResult.usage,
        limit: thresholdResult.limit,
      });
      try {
        await context.client.session.summarize({
          path: { id: props.sessionID },
          ...(curModel
            ? { body: { providerID: curModel.providerID, modelID: curModel.modelID } }
            : {}),
        });
      } catch {
        await logger.info("Idle: manual compact failed for non-registered agent", {
          sessionID: props.sessionID,
        });
      }
      return;
    }

    const parsedModel = getAgentLargeContextModel(config, agent);
    if (!parsedModel) return;

    const thresholdResult = await checkContextThreshold(props.sessionID, context, logger);
    if (thresholdResult.limit === 0 || !thresholdResult.atThreshold) return;

    await logger.info("Idle: context at limit, switching to large model", {
      sessionID: props.sessionID,
      agent,
      usage: thresholdResult.usage,
      limit: thresholdResult.limit,
    });

    const curModel = getCurrentModel(props.sessionID);
    if (curModel) {
      if (isSameModel(curModel, parsedModel)) return;
      if (isModelInCooldown(parsedModel.providerID, parsedModel.modelID)) return;
      const largeLimit = getModelContextLimit(formatModelKey(parsedModel));
      const minRatio = getAgentMinContextRatio(config, agent);
      if (largeLimit && shouldSkipLargeContextFallback(thresholdResult.limit, largeLimit, minRatio)) return;
    }

    await handleLargeContextSwitch(
      props.sessionID,
      parsedModel,
      context,
      logger,
      `Context at ${((thresholdResult.usage / thresholdResult.limit) * 100).toFixed(1)}%`,
    );
    return;
  }

  if (phase === "pending") {
    return;
  }

  if (phase === "active") {
    const activeParsedModel = agent ? getAgentLargeContextModel(config, agent) : null;
    if (!activeParsedModel) {
      await logger.info("Idle: active — no large context model, clearing phase", {
        sessionID: props.sessionID,
      });
      deleteLargeContextPhase(props.sessionID);
      return;
    }

    const largeThreshold = await checkContextThreshold(props.sessionID, context, logger);
    if (largeThreshold.atThreshold) {
      await logger.info("Idle: large model context full, self-compacting", {
        sessionID: props.sessionID,
      });
      setCompactionTarget(props.sessionID, "large");
      try {
        await context.client.session.summarize({
          path: { id: props.sessionID },
          body: {
            providerID: activeParsedModel.providerID,
            modelID: activeParsedModel.modelID,
          },
        });
      } catch {
        clearCompactionTarget(props.sessionID);
        await logger.info("Idle: self-compaction failed, cleared compactionTarget", {
          sessionID: props.sessionID,
        });
      }
      return;
    }

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

  if (agent && getAgentLargeContextModel(config, agent)) {
    await handleLargeContextCompletion(props.sessionID, context, logger);
  }
}

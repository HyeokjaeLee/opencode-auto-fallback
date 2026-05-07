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
  getModelContextLimit,
  setSessionOriginalAgent,
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
  const phase = getLargeContextPhase(props.sessionID);
  let agent = getSessionOriginalAgent(props.sessionID);

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

    const parsedModel = getAgentLargeContextModel(config, agent);
    if (!parsedModel) return;
    if (!isRegisteredAgent(agent)) return;

    const thresholdResult = await checkContextThreshold(props.sessionID, context, logger);
    if (!thresholdResult.atThreshold) return;

    await logger.info("Idle: registered agent at threshold, checking guards", {
      sessionID: props.sessionID,
      agent,
      usage: thresholdResult.usage,
      limit: thresholdResult.limit,
    });

    const curModel = getCurrentModel(props.sessionID);
    if (curModel) {
      if (isSameModel(curModel, parsedModel)) {
        await logger.info("Idle: guard — already on large model", {
          sessionID: props.sessionID,
          model: formatModelKey(curModel),
        });
        return;
      }
      if (isModelInCooldown(parsedModel.providerID, parsedModel.modelID)) {
        await logger.info("Idle: guard — large model in cooldown", {
          sessionID: props.sessionID,
          model: formatModelKey(parsedModel),
        });
        return;
      }
      const largeLimit = getModelContextLimit(formatModelKey(parsedModel));
      const minRatio = getAgentMinContextRatio(config, agent);
      if (largeLimit && shouldSkipLargeContextFallback(thresholdResult.limit, largeLimit, minRatio)) {
        await logger.info("Idle: guard — context window ratio too small", {
          sessionID: props.sessionID,
          currentLimit: thresholdResult.limit,
          largeLimit,
          minRatio,
        });
        return;
      }
    }
    await logger.info("Idle: all guards passed, switching to large model", {
      sessionID: props.sessionID,
      largeModel: formatModelKey(parsedModel),
    });
    const switched = await handleLargeContextSwitch(
      props.sessionID,
      parsedModel,
      context,
      logger,
      `Context at ${((thresholdResult.usage / thresholdResult.limit) * 100).toFixed(1)}%`,
    );
    await logger.info("Idle: large context switch result", {
      sessionID: props.sessionID,
      success: switched,
    });
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

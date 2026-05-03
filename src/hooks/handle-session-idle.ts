import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig } from "@/config/types";
import { getParsedLcfModel } from "@/config/config";
import { isModelInCooldown } from "@/state/provider-state";
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
import type { Logger } from "@/utils/session-utils";
import { formatModelKey, isSameModel } from "@/utils/model";
import { fetchSessionData } from "@/utils/session-utils";
import {
  handleLargeContextSwitch,
  handleLargeContextReturn,
  handleLargeContextCompletion,
  shouldSkipLargeContextFallback,
} from "@/core/large-context";
import { checkContextThreshold } from "@/utils/context";

export async function handleSessionIdle(
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

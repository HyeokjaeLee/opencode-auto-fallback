import { getAgentLargeContextModel } from "@/config/config";
import { LARGE_CONTEXT_CONTINUATION } from "@/config/constants";
import type { FallbackConfig } from "@/config/types";
import { handleLargeContextCompletion, handleLargeContextReturn } from "@/core/large-context";
import {
  clearOpencodeCompacting,
  clearSyntheticPromptActive,
  deleteLargeContextPhase,
  getAndClearCompactionTarget,
  getLargeContextPhase,
  getMaxSelfCompactionCycles,
  getSessionOriginalAgent,
  getSelfCompactionCount,
  resetSelfCompactionCount,
  setSyntheticPromptActive,
} from "@/state/context-state";
import { serializeError } from "@/utils/error";
import { buildSyntheticContinuationPart } from "@/utils/fallback-notification";
import type { Logger } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function handleSessionCompacted(
  config: FallbackConfig,
  logger: Logger,
  context: PluginInput,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { sessionID: string };
  const phase = getLargeContextPhase(props.sessionID);
  await logger.info("Compacted event received", {
    sessionID: props.sessionID,
    phase,
  });

  clearOpencodeCompacting(props.sessionID);

  if (phase === "summarizing") {
    const agent = getSessionOriginalAgent(props.sessionID);
    if (agent && getAgentLargeContextModel(config, agent)) {
      await handleLargeContextCompletion(props.sessionID, config, context, logger);
    } else {
      await logger.info("Compacted: summarizing but no agent/largeModel — clearing phase", {
        sessionID: props.sessionID,
      });
      deleteLargeContextPhase(props.sessionID);
    }
    return;
  }

  if (phase === "active") {
    const target = getAndClearCompactionTarget(props.sessionID);

    if (target === "default") {
      await logger.info("Compacted: manual compact during active phase, switching back", {
        sessionID: props.sessionID,
      });
      resetSelfCompactionCount(props.sessionID);
      await handleLargeContextReturn(props.sessionID, config, context, logger);
      return;
    }

    const selfCompactionCount = getSelfCompactionCount(props.sessionID);

    if (selfCompactionCount >= getMaxSelfCompactionCycles()) {
      await logger.info("Compacted: max self-compaction cycles reached, switching back", {
        sessionID: props.sessionID,
        selfCompactionCount,
      });
      resetSelfCompactionCount(props.sessionID);

      await handleLargeContextReturn(props.sessionID, config, context, logger);
      return;
    }

    await logger.info("Compacted: large model compaction complete, continuing on large model", {
      sessionID: props.sessionID,
    });

    const agent = getSessionOriginalAgent(props.sessionID);
    const largeModel = agent ? getAgentLargeContextModel(config, agent) : null;

    setSyntheticPromptActive(props.sessionID);
    context.client.session
      .prompt({
        path: { id: props.sessionID },
        body: {
          ...(largeModel
            ? { model: { providerID: largeModel.providerID, modelID: largeModel.modelID } }
            : {}),
          parts: [buildSyntheticContinuationPart(LARGE_CONTEXT_CONTINUATION)],
        },
      })
      .catch(async (err) => {
        await logger.warn("Self-compaction: continuation prompt failed", {
          sessionID: props.sessionID,
          error: serializeError(err),
        });
      })
      .finally(() => {
        clearSyntheticPromptActive(props.sessionID);
      });
  }
}

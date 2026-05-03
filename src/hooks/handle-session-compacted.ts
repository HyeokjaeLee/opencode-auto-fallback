import { LARGE_CONTEXT_CONTINUATION } from "@/config/constants";
import type { FallbackConfig } from "@/config/types";
import { getLargeContextPhase } from "@/state/context-state";
import { serializeError } from "@/utils/error";
import type { Logger } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

export async function handleSessionCompacted(
  _config: FallbackConfig,
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

  if (phase === "summarizing") {
    await logger.info("Compacted: summarizing complete, next idle will switch back", {
      sessionID: props.sessionID,
    });
    return;
  }

  if (phase === "active") {
    await logger.info("Compacted: large model compaction complete, continuing on large model", {
      sessionID: props.sessionID,
    });
    context.client.session
      .prompt({
        path: { id: props.sessionID },
        body: {
          parts: [
            {
              type: "text" as const,
              text: LARGE_CONTEXT_CONTINUATION,
            },
          ],
        },
      })
      .catch(async (err) => {
        await logger.warn("Self-compaction: continuation prompt failed", {
          sessionID: props.sessionID,
          error: serializeError(err),
        });
      });
  }
}

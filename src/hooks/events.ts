import type { PluginInput } from "@opencode-ai/plugin";
import type { FallbackConfig } from "@/config/types";
import type { Logger } from "@/utils/session-utils";
import { handleSessionCompacted } from "./handle-session-compacted";
import { handleSessionDeleted } from "./handle-session-deleted";
import { handleSessionError } from "./handle-session-error";
import { handleSessionIdle } from "./handle-session-idle";
import { handleSessionStatus } from "./handle-session-status";

export function createEventHandler(config: FallbackConfig, logger: Logger, context: PluginInput) {
  return async ({ event }: { event: { type: string; properties: unknown } }) => {
    if (event.type === "session.error") {
      await handleSessionError(config, logger, context, event);
    } else if (event.type === "session.compacted") {
      await handleSessionCompacted(config, logger, context, event);
    } else if (event.type === "session.idle") {
      await handleSessionIdle(config, logger, context, event);
    } else if (event.type === "session.status") {
      await handleSessionStatus(config, logger, context, event);
    } else if (event.type === "session.deleted") {
      await handleSessionDeleted(logger, event);
    }
  };
}

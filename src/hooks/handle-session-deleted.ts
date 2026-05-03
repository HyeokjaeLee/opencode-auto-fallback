import type { Logger } from "@/utils/session-utils";
import { removeSession } from "@/state/session-state";
import { cleanupSession } from "@/state/context-state";

export async function handleSessionDeleted(
  logger: Logger,
  event: { type: string; properties: unknown },
): Promise<void> {
  const props = event.properties as { info?: { id?: string } };
  if (props.info?.id) {
    removeSession(props.info.id);
    cleanupSession(props.info.id);
    await logger.info("Session cleaned up", { sessionID: props.info.id });
  }
}

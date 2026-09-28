import {
  CONTINUATION_OBSERVE_TIMEOUT_MS,
  CONTINUATION_VERIFY_POLL_INTERVAL_MS,
  CONTINUATION_VERIFY_TIMEOUT_MS,
} from "@/config/constants";
import type { Logger } from "@/utils/session-utils";
import { withTimeout } from "@/utils/subagent";

import type { PluginInput } from "@opencode-ai/plugin";

/** Assistant-message fingerprint: message ids plus the shape of the last message. */
export interface AssistantActivitySnapshot {
  ids: Set<string>;
  lastSignature: string | null;
}

export interface ContinuationMonitorHandle {
  /** Suppresses the "continuation lost" error (e.g. the prompt explicitly rejected). */
  suppress: () => void;
}

async function observeAssistantActivity(
  sessionID: string,
  context: PluginInput,
): Promise<AssistantActivitySnapshot | undefined> {
  try {
    const response = await withTimeout(
      context.client.session.messages({ path: { id: sessionID } }),
      CONTINUATION_OBSERVE_TIMEOUT_MS,
      undefined,
    );
    const raw = (response?.data ?? []) as Array<{
      info: { id?: string; role: string };
      parts?: unknown[];
    }>;
    const ids = new Set<string>();
    let lastSignature: string | null = null;
    for (const message of raw) {
      if (message.info.role !== "assistant") continue;
      const id = message.info.id ?? "";
      ids.add(id);
      const partCount = Array.isArray(message.parts) ? message.parts.length : 0;
      lastSignature = `${id}:${partCount}`;
    }
    return { ids, lastSignature };
  } catch {
    return undefined;
  }
}

function hasNewActivity(
  baseline: AssistantActivitySnapshot | undefined,
  current: AssistantActivitySnapshot,
): boolean {
  // A failed baseline cannot distinguish old from new; count any assistant
  // message as activity to avoid false "lost" alarms.
  if (!baseline) return current.ids.size > 0;
  for (const id of current.ids) {
    if (!baseline.ids.has(id)) return true;
  }
  return current.lastSignature !== baseline.lastSignature;
}

/**
 * Observes whether a session produces new assistant activity after a
 * fire-and-forget continuation prompt. A caller process that exits right after
 * aborting (e.g. one-shot `opencode run`) cannot deliver the continuation —
 * this best-effort check makes that failure visible in the plugin log when a
 * logger callback can still run (issues #7, #5).
 */
export function monitorContinuationActivity(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): ContinuationMonitorHandle {
  const state = { suppressed: false };

  const run = async (): Promise<void> => {
    const baseline = await observeAssistantActivity(sessionID, context);
    const deadline = Date.now() + CONTINUATION_VERIFY_TIMEOUT_MS;
    let sawSuccessfulObservation = baseline !== undefined;

    for (;;) {
      const current = await observeAssistantActivity(sessionID, context);
      if (current) {
        sawSuccessfulObservation = true;
        if (hasNewActivity(baseline, current)) {
          await logger.info("Continuation verified: new assistant activity observed", {
            sessionID,
          });
          return;
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, CONTINUATION_VERIFY_POLL_INTERVAL_MS));
    }

    if (state.suppressed) return;
    if (!sawSuccessfulObservation) {
      await logger.warn("Continuation could not be verified (session observations failed)", {
        sessionID,
      });
      return;
    }
    await logger.error("continuation lost — caller process likely exited (e.g. opencode run)", {
      sessionID,
      watchedMs: CONTINUATION_VERIFY_TIMEOUT_MS,
    });
  };

  // Detached: monitor failures must never surface as unhandled rejections.
  void run().catch(() => {});

  return {
    suppress: () => {
      state.suppressed = true;
    },
  };
}

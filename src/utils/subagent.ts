import {
  SUBAGENT_IDLE_POLL_INTERVAL_MS,
  SUBAGENT_IDLE_TIMEOUT_MS,
  SUBAGENT_LOOKUP_TIMEOUT_MS,
} from "@/config/constants";
import { serializeError } from "@/utils/error";
import type { Logger } from "@/utils/session-utils";
import { abortSession } from "@/utils/session-utils";

import type { PluginInput } from "@opencode-ai/plugin";

/**
 * true = task-tool child session, false = root session,
 * undefined = metadata unavailable (SDK call failed or timed out).
 */
export type SubagentDetection = boolean | undefined;

/** Outcome of preparing a session for a replacement prompt. */
export type SessionRecovery = "aborted" | "ready" | "not-ready";

/** Bounded await: resolves with `fallback` when the promise exceeds `timeoutMs`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function isSubagentSession(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<SubagentDetection> {
  try {
    const response = await withTimeout(
      context.client.session.get({ path: { id: sessionID } }),
      SUBAGENT_LOOKUP_TIMEOUT_MS,
      undefined,
    );
    if (!response?.data) {
      await logger.warn("Session metadata unavailable, treating recovery as abort-free", {
        sessionID,
      });
      return undefined;
    }
    return Boolean(response.data.parentID);
  } catch (err) {
    await logger.warn("Session metadata lookup failed, treating recovery as abort-free", {
      sessionID,
      error: serializeError(err),
    });
    return undefined;
  }
}

/**
 * Idle per the status API: an absent map entry or an explicit `idle` entry.
 * A failed/undefined response is NOT proof of idle.
 */
async function isSessionIdle(
  sessionID: string,
  context: PluginInput,
): Promise<boolean | undefined> {
  try {
    const response = await withTimeout(
      context.client.session.status(),
      SUBAGENT_LOOKUP_TIMEOUT_MS,
      undefined,
    );
    const data = response?.data;
    if (!data) return undefined;
    if (!(sessionID in data)) return true;
    return data[sessionID].type === "idle";
  } catch {
    return undefined;
  }
}

export async function waitForSessionIdle(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<boolean> {
  const deadline = Date.now() + SUBAGENT_IDLE_TIMEOUT_MS;
  for (;;) {
    if (await isSessionIdle(sessionID, context)) return true;
    if (Date.now() >= deadline) {
      await logger.warn("Session did not become idle in time, skipping recovery prompt", {
        sessionID,
      });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SUBAGENT_IDLE_POLL_INTERVAL_MS));
  }
}

/**
 * Prepares a session for a replacement prompt. Aborting a task-tool child
 * session cancels the parent's task call (issue #4), so children — and sessions
 * whose ownership is unknown — are never aborted; they are only used once the
 * status API reports them idle.
 */
export async function prepareSessionForPrompt(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
): Promise<SessionRecovery> {
  const isChild = await isSubagentSession(sessionID, context, logger);
  if (isChild === false) {
    await abortSession(sessionID, context);
    return "aborted";
  }
  const idle = await waitForSessionIdle(sessionID, context, logger);
  return idle ? "ready" : "not-ready";
}

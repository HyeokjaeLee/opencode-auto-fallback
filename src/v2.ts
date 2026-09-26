/**
 * OpenCode V2 adapter for opencode-auto-fallback.
 *
 * OpenCode V2 (>= 2.0.x) loads plugins through `@opencode/plugin` and expects a
 * default export shaped as `{ id, setup }` (see `Plugin.define`). The V2 plugin
 * context is NOT the V1 `PluginInput`, so this adapter maps the subset of V1
 * behavior that has a faithful V2 equivalent:
 *
 *   - V1 `chat.params`  -> `ctx.session.hook("context", ...)`
 *   - V1 `event`        -> `ctx.event.subscribe()`
 *   - V1 error handling -> `ctx.session.hook("retry", ...)`
 *
 * V2 deliberately does not expose `session.summarize`, `session.revert`, or
 * `session.messages` to plugins. The V1-only features that depend on those APIs
 * therefore cannot be ported and remain V1-only:
 *
 *   - large-context model switching (needs `summarize` + message history)
 *   - prefill-not-supported recovery (needs `revert`)
 *   - compaction prompt injection (no V2 `experimental.session.compacting`)
 *
 * The full V1 implementation is preserved untouched and exposed as `server` on
 * the package default export, so OpenCode V1 (1.18.29+) keeps every feature.
 */

import { getFallbackChain, getRegisteredAgentNames, loadConfig } from "@/config/config";
import { BACKOFF_BASE_MS, LARGE_CONTEXT_CONTINUATION } from "@/config/constants";
import type { FallbackConfig, FallbackModel } from "@/config/types";
import { classifyError, isPermanentRateLimitMessage } from "@/core/decision";
import {
  cleanupSession,
  getAndClearFallbackParams,
  getCurrentModel,
  getSessionOriginalAgent,
  hasModelChanged,
  isRegisteredAgent,
  setActiveFallbackParams,
  setCurrentModel,
  setRegisteredAgents,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { isModelInCooldown, markModelCooldown } from "@/state/provider-state";
import {
  activateCooldown,
  deactivateCooldown,
  incrementBackoff,
  isCooldownActive,
  resetBackoff,
} from "@/state/session-state";
import { serializeError } from "@/utils/error";
import { createLogger } from "@/utils/log";
import { formatModelKey } from "@/utils/model";
import type { Logger } from "@/utils/session-utils";

/** Stable identifier reported to OpenCode V2. Also scopes plugin storage. */
export const PLUGIN_ID = "opencode-auto-fallback";

/** Model reference as used by V2 session APIs (`Model.Ref`). */
export interface V2ModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

/** Mutable event passed to the V2 `retry` session hook. */
export interface V2SessionRetry {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: V2ModelRef;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly status?: number;
  };
  readonly attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
}

/** Mutable event passed to the V2 `context` session hook. */
export interface V2SessionContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: V2ModelRef;
  readonly options: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: string;
    thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
    [key: string]: unknown;
  };
}

interface V2Event {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

interface V2Registration {
  dispose: () => Promise<void>;
}

interface V2SessionHookMap {
  context: V2SessionContext;
  retry: V2SessionRetry;
}

type V2SessionHook = <Name extends keyof V2SessionHookMap>(
  name: Name,
  callback: (event: V2SessionHookMap[Name]) => Promise<void> | void,
) => Promise<V2Registration>;

/**
 * Minimal surface of the V2 plugin context used by this adapter. Declared
 * locally (rather than importing `Plugin.Context`) so the published types stay
 * self-contained and V1 consumers do not need the V2 packages installed.
 */
export interface V2ContextLike {
  readonly session: {
    readonly hook: V2SessionHook;
    readonly switchModel: (input: { sessionID: string; model: V2ModelRef }) => Promise<void>;
    readonly prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
  };
  readonly event: {
    readonly subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<V2Event>;
  };
}

/**
 * V2 plugin entrypoint. Registers the mappable hooks and returns a cleanup
 * function that stops the event subscription.
 */
export async function setupV2(ctx: V2ContextLike): Promise<() => void> {
  const config = loadConfig();
  const logger = createLogger(config.logging);

  await logger.info("V2 adapter initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agents: Object.keys(config.agents),
    maxRetries: config.maxRetries,
    cooldownMs: config.cooldownMs,
  });

  if (!config.enabled) {
    await logger.info("Plugin disabled via config (V2)");
    return () => {};
  }

  setRegisteredAgents(getRegisteredAgentNames(config));

  await ctx.session.hook("context", (event) => {
    handleContext(event, logger);
  });
  await ctx.session.hook("retry", async (event) => {
    await handleRetry(event, config, logger, ctx);
  });

  const controller = new AbortController();
  void subscribeEvents(ctx, controller.signal, logger);

  return () => {
    controller.abort();
  };
}

function handleContext(event: V2SessionContext, logger: Logger): void {
  if (event.agent && isRegisteredAgent(event.agent) && !getSessionOriginalAgent(event.sessionID)) {
    setSessionOriginalAgent(event.sessionID, event.agent);
  }

  const { changed } = hasModelChanged(event.sessionID, event.model.providerID, event.model.id);
  setCurrentModel(event.sessionID, event.model.providerID, event.model.id);
  if (changed) {
    deactivateCooldown(event.sessionID);
  }

  const fallback = getAndClearFallbackParams(event.sessionID);
  if (!fallback) return;

  if (fallback.temperature !== undefined) event.options.temperature = fallback.temperature;
  if (fallback.topP !== undefined) event.options.topP = fallback.topP;
  if (fallback.maxTokens !== undefined) event.options.maxTokens = fallback.maxTokens;
  if (fallback.reasoningEffort !== undefined) {
    event.options.reasoningEffort = fallback.reasoningEffort;
  }
  if (fallback.thinking !== undefined) event.options.thinking = fallback.thinking;

  void logger.info("V2 applied fallback params", {
    sessionID: event.sessionID,
    model: formatModelKey(fallback),
  });
}

async function handleRetry(
  event: V2SessionRetry,
  config: FallbackConfig,
  logger: Logger,
  ctx: V2ContextLike,
): Promise<void> {
  const { sessionID, error } = event;

  if (isCooldownActive(sessionID)) {
    event.decision = { retry: false };
    return;
  }

  if (isPermanentRateLimitMessage(error.message)) {
    event.decision = { retry: false };
    await triggerFallback(sessionID, event.agent, "Permanent rate limit", logger, ctx, config);
    return;
  }

  const decision = classifyError(error.status, undefined, false);
  if (decision.action === "immediate") {
    event.decision = { retry: false };
    await triggerFallback(sessionID, event.agent, "Immediate fallback", logger, ctx, config);
    return;
  }

  const backoffLevel = incrementBackoff(sessionID);
  if (backoffLevel <= config.maxRetries) {
    const delay = BACKOFF_BASE_MS * 2 ** (backoffLevel - 1);
    event.decision = { retry: true, delay };
    await logger.info("V2 retry scheduled", {
      sessionID,
      attempt: event.attempt,
      backoffLevel,
      delay,
      status: error.status,
    });
    return;
  }

  resetBackoff(sessionID);
  event.decision = { retry: false };
  await triggerFallback(sessionID, event.agent, "Retries exhausted", logger, ctx, config);
}

async function triggerFallback(
  sessionID: string,
  agent: string,
  reason: string,
  logger: Logger,
  ctx: V2ContextLike,
  config: FallbackConfig,
): Promise<boolean> {
  const currentModel = getCurrentModel(sessionID);
  const originalAgent = getSessionOriginalAgent(sessionID) ?? agent;

  activateCooldown(sessionID, config.cooldownMs);
  if (currentModel) {
    markModelCooldown(currentModel.providerID, currentModel.modelID, config.cooldownMs);
  }

  const chain = getFallbackChain(config, originalAgent);
  if (chain.length === 0) {
    await logger.warn("V2 fallback: no chain configured", { sessionID, agent: originalAgent });
    return false;
  }

  for (const model of chain) {
    if (isModelInCooldown(model.providerID, model.modelID)) {
      continue;
    }
    if (await applyFallbackModel(sessionID, model, reason, logger, ctx)) {
      return true;
    }
  }

  await logger.error("V2 fallback chain exhausted", { sessionID, chainLength: chain.length });
  return false;
}

async function applyFallbackModel(
  sessionID: string,
  model: FallbackModel,
  reason: string,
  logger: Logger,
  ctx: V2ContextLike,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, model);
    const modelRef: V2ModelRef =
      model.variant !== undefined
        ? { id: model.modelID, providerID: model.providerID, variant: model.variant }
        : { id: model.modelID, providerID: model.providerID };
    await ctx.session.switchModel({ sessionID, model: modelRef });
    await ctx.session.prompt({ sessionID, text: LARGE_CONTEXT_CONTINUATION });
    await logger.info("V2 fallback switched model", {
      sessionID,
      model: formatModelKey(model),
      reason,
    });
    return true;
  } catch (err) {
    await logger.warn("V2 fallback switch failed", {
      sessionID,
      model: formatModelKey(model),
      reason,
      error: serializeError(err),
    });
    return false;
  }
}

async function subscribeEvents(
  ctx: V2ContextLike,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      handleEvent(event);
    }
  } catch (err) {
    if (!signal.aborted) {
      await logger.warn("V2 event subscription ended", { error: serializeError(err) });
    }
  }
}

function handleEvent(event: V2Event): void {
  switch (event.type) {
    case "session.deleted": {
      const sessionID = readSessionID(event.data);
      if (sessionID) cleanupSession(sessionID);
      break;
    }
    case "session.model.selected": {
      const sessionID = readSessionID(event.data);
      const model = readModelRef(event.data);
      if (sessionID && model) {
        setCurrentModel(sessionID, model.providerID, model.id);
        deactivateCooldown(sessionID);
      }
      break;
    }
    default:
      break;
  }
}

function readSessionID(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const value = data.sessionID;
  return typeof value === "string" ? value : undefined;
}

function readModelRef(
  data: Record<string, unknown> | undefined,
): { providerID: string; id: string } | undefined {
  if (!data) return undefined;
  const value = data.model;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const providerID = record.providerID;
  const id = record.id;
  if (typeof providerID !== "string" || typeof id !== "string") return undefined;
  return { providerID, id };
}

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Extended hooks type for runtime-only hooks not in the SDK types
type PluginHooks = Hooks & {
  "experimental.compaction.autocontinue"?: (
    input: { sessionID: string; agent: string; model?: { providerID: string; modelID: string } },
    output: { enabled: boolean },
  ) => Promise<void>
}
import type { FallbackConfig, FallbackModel, ToastOptions } from "./types"
import { getFallbackChain, loadConfig, normalizeAgentName, parseModel } from "./config"
import { classifyError, isTransientErrorMessage, isPermanentRateLimitMessage, isContextOverflowError } from "./decision"
import {
  BACKOFF_BASE_MS,
  ABORT_DELAY_MS,
  REVERT_DELAY_MS,
  TOAST_DURATION_MS,
  TOAST_DURATION_LONG_MS,
  LARGE_CONTEXT_CONTINUATION,
  RETURN_CONTINUATION,
} from "./constants"
import { createLogger } from "./log"
import {
  isCooldownActive,
  activateCooldown,
  deactivateCooldown,
  resetIfExpired,
  removeSession,
  incrementBackoff,
  resetBackoff,
} from "./session-state"
import { markModelCooldown, isModelInCooldown, cleanupExpired } from "./provider-state"
import { checkForUpdates, tryInstallUpdate } from "./update-checker"
import { version as currentVersion } from "../package.json"
import { extractUserParts, type PromptPart } from "./message"
import type { Message as SDKMessage, Part as SDKPart } from "@opencode-ai/sdk"
import { adaptMessages, getModelFromMessage } from "./adapters/sdk-adapter"
import {
  setActiveFallbackParams,
  clearActiveFallbackParams,
  getAndClearFallbackParams,
  setCurrentModel,
  getCurrentModel,
  hasModelChanged,
  getOrSetOriginalModel,
  getOriginalModel,
  setLargeContextPhase,
  getLargeContextPhase,
  deleteLargeContextPhase,
  setModelContextLimit,
  getModelContextLimit,
  setSessionCooldownModel,
  getSessionCooldownModel,
  deleteSessionCooldownModel,
  cleanupSession,
  setSessionOriginalAgent,
  getSessionOriginalAgent,
  hasActiveFork,
  getForkTracking,
  setRestoreModel,
  getRestoreModel,
  deleteRestoreModel,
  setRegisteredAgents,
  isRegisteredAgent,
  setCompactionReserved,
  getCompactionReserved,
  clearLargeModelIdle,
  setCompactionTarget,
  getAndClearCompactionTarget,
  clearCompactionTarget,
} from "./state/context-state"

import { injectForkResult } from "./session-fork"

// tui is available at runtime but not typed in the SDK

interface ToastClient {
  showToast(params: { body: ToastOptions }): Promise<unknown>
}

type ClientWithTui = PluginInput["client"] & { tui?: ToastClient }

function contextWindowFor(model: { providerID: string; modelID: string }): number | undefined {
  return getModelContextLimit(`${model.providerID}/${model.modelID}`)
}

async function hasActiveChildren(sessionID: string, context: PluginInput): Promise<boolean> {
  try {
    const resp = await context.client.session.children({ path: { id: sessionID } })
    const children = (resp?.data ?? []) as Array<{ id: string }>
    if (children.length === 0) return false
    // Check child session status individually via the session.status API
    const statusResp = await context.client.session.status()
    const allStatuses = (statusResp?.data ?? {}) as Record<string, { type: string }>
    return children.some(c => {
      const s = allStatuses[c.id]
      return !s || s.type === "busy" || s.type === "retry"
    })
  } catch {
    // Fail-closed
    return true
  }
}

async function checkContextThreshold(
  sessionID: string,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<{ atThreshold: boolean; usage: number; limit: number }> {
  try {
    const msgResp = await context.client.session.messages({ path: { id: sessionID } })
    const raw = (msgResp.data ?? []) as Array<{ info: { role: string; tokens?: { input: number; output?: number } } }>

    // Find the last assistant message that has non-zero token data.
    // info.tokens.input is the cumulative prompt tokens for that generation,
    // matching the context usage shown in the OpenCode TUI.
    // The very last message may have input=0 if the SDK hasn't populated it yet,
    // so we scan backwards for the most recent message with real data.
    let asstCount = 0
    let lastInput = 0
    let lastOutput = 0
    let cumulativeInput = 0
    let cumulativeOutput = 0
    let maxInput = 0

    for (const m of raw) {
      if (m.info.role === "assistant" && m.info.tokens?.input != null) {
        const inVal = m.info.tokens.input
        const outVal = m.info.tokens.output ?? 0
        asstCount++
        cumulativeInput += inVal
        cumulativeOutput += outVal
        if (inVal > maxInput) maxInput = inVal
        if (inVal > 0) {
          lastInput = inVal
          lastOutput = outVal
        }
      }
    }

    // Use the last non-zero assistant message's input as the cumulative context
    const tokensInput = lastInput
    const tokensOutput = lastOutput

    if (asstCount === 0 || tokensInput === 0) {
      await logger.info("Idle: no assistant messages with token data", { sessionID })
      return { atThreshold: false, usage: 0, limit: 0 }
    }

    const curModel = getCurrentModel(sessionID)
    if (!curModel) return { atThreshold: false, usage: 0, limit: 0 }
    const modelKey = `${curModel.providerID}/${curModel.modelID}`
    const limit = getModelContextLimit(modelKey)
    if (!limit) return { atThreshold: false, usage: 0, limit: 0 }

    const usage = tokensInput + tokensOutput

    // Diagnostic: compare with sum approach and maxInput for verification
    const diagnostic = {
      sumInput: cumulativeInput,
      sumOutput: cumulativeOutput,
      maxInput,
      lastNonZeroInput: tokensInput,
      lastNonZeroOutput: tokensOutput,
    }

    const reserved = getCompactionReserved()

    let atThreshold: boolean
    if (reserved !== undefined) {
      atThreshold = usage >= limit - reserved
    } else {
      atThreshold = usage / limit >= 0.80
    }

    await logger.info("Idle: context check", {
      sessionID, asstCount,
      tokensInput, tokensOutput, usage, limit,
      diagnostic,
      reserved: reserved ?? "unset (using 80% ratio)",
      threshold: reserved ? `limit - reserved = ${limit - reserved}` : `${(0.80 * 100).toFixed(0)}%`,
      atThreshold,
    })
    return { atThreshold, usage, limit }
  } catch (err) {
    await logger.info("Idle: threshold check error", {
      sessionID, error: err instanceof Error ? err.message : String(err),
    })
    return { atThreshold: false, usage: 0, limit: 0 }
  }
}

function shouldSkipLargeContextFallback(
  currentWindow: number,
  largeWindow: number,
  minContextRatio: number,
): boolean {
  return largeWindow / currentWindow <= 1 + minContextRatio
}

async function showToastSafely(
  context: PluginInput,
  body: ToastOptions,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const client = context.client as ClientWithTui
    await client.tui?.showToast({ body })
  } catch (err) {
    await logger.warn("Toast failed", { error: err instanceof Error ? err.message : String(err) })
  }
}

interface ChatMessageInput {
  sessionID: string
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
}

async function fetchSessionData(sessionID: string, context: PluginInput, logger: ReturnType<typeof createLogger>, hookInput?: ChatMessageInput) {
  const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
  const raw = (messagesResponse.data ?? []) as Array<{ info: SDKMessage; parts: SDKPart[] }>
  const messages = adaptMessages(raw)
  let extracted = extractUserParts(messages)
  if (!extracted) {
    await logger.info("No user parts found (non-synthetic), retrying with synthetic allowed", { sessionID })
    extracted = extractUserParts(messages, { allowSynthetic: true })
  }
  const lastAssistant = [...raw].reverse().find(m => m.info.role === "assistant")
  const currentModel = lastAssistant
    ? getModelFromMessage(lastAssistant.info)
    : hookInput?.model ?? getCurrentModel(sessionID)
  return { messages, extracted, currentModel }
}

async function abortSession(sessionID: string, context: PluginInput) {
  await context.client.session.abort({ path: { id: sessionID } })
  await new Promise(resolve => setTimeout(resolve, ABORT_DELAY_MS))
}

async function revertAndPrompt(
  sessionID: string,
  agent: string | undefined,
  parts: PromptPart[],
  messageID: string,
  model: FallbackModel,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, model)
    await context.client.session.revert({ path: { id: sessionID }, body: { messageID } })
    await new Promise(resolve => setTimeout(resolve, REVERT_DELAY_MS))
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: model.providerID, modelID: model.modelID },
        agent,
        parts,
        ...(model.variant ? { variant: model.variant } : {}),
      },
    })
    return true
  } catch (err) {
    await logger.warn("Prompt failed", { sessionID, model, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

async function tryFallbackChain(
  sessionID: string,
  chain: FallbackModel[],
  agent: string | undefined,
  parts: PromptPart[],
  messageID: string,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
): Promise<boolean> {
  for (let i = 0; i < chain.length; i++) {
    if (isModelInCooldown(chain[i].providerID, chain[i].modelID)) {
      await logger.info(`Skipping model in cooldown ${chain[i].providerID}/${chain[i].modelID}`, {
        sessionID, model: chain[i], remaining: chain.length - i - 1,
      })
      continue
    }
    await logger.info(`Trying fallback ${i + 1}/${chain.length}`, { sessionID, model: chain[i] })
    if (await revertAndPrompt(sessionID, agent, parts, messageID, chain[i], logger, context)) {
      await logger.info("Fallback chain succeeded", { sessionID, triedCount: i + 1 })
      await showToastSafely(context, {
        title: "Model Fallback",
        message: `Switched to ${chain[i].providerID}/${chain[i].modelID}`,
        variant: "info",
        duration: TOAST_DURATION_MS,
      }, logger)
      return true
    }
  }
  await showToastSafely(context, {
    title: "Fallback Failed",
    message: "All fallback models exhausted",
    variant: "error",
    duration: TOAST_DURATION_MS,
  }, logger)
  await logger.error("All fallback models exhausted", { sessionID, chainLength: chain.length })
  return false
}

async function handleRetry(
  sessionID: string,
  config: FallbackConfig,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
  hookInput?: ChatMessageInput,
) {
  const backoffLevel = incrementBackoff(sessionID)
  const { extracted, currentModel } = await fetchSessionData(sessionID, context, logger, hookInput)
  if (!extracted) {
    await logger.error("Cannot retry: missing user message", { sessionID })
    return
  }

  await abortSession(sessionID, context)

  if (currentModel && backoffLevel <= config.maxRetries) {
    const waitMs = BACKOFF_BASE_MS * Math.pow(2, backoffLevel - 1)
    await logger.info(`Backoff retry ${backoffLevel}/${config.maxRetries} (${waitMs}ms)`, { sessionID })
    await new Promise(resolve => setTimeout(resolve, waitMs))
    const ok = await revertAndPrompt(
      sessionID, extracted.info.agent, extracted.parts, extracted.info.id,
      { providerID: currentModel.providerID, modelID: currentModel.modelID },
      logger, context,
    )
    if (ok) {
      await logger.info("Retry succeeded with same model", { sessionID, backoffLevel })
      return
    }
  }

  resetBackoff(sessionID)
  if (!currentModel) {
    await logger.warn("No current model available, going straight to fallback chain", { sessionID })
  } else {
    await showToastSafely(context, {
      title: "Retries Exhausted",
      message: `Switching to fallback after ${config.maxRetries} retries`,
      variant: "warning",
      duration: TOAST_DURATION_MS,
    }, logger)
    await logger.info(`Retries exhausted (${backoffLevel}), starting fallback chain`, { sessionID })
  }
  const chain = getFallbackChain(config, extracted.info.agent)
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", { sessionID, agent: extracted.info.agent })
    return
  }
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

async function handleImmediate(
  sessionID: string,
  config: FallbackConfig,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
  hookInput?: ChatMessageInput,
) {
  activateCooldown(sessionID, config.cooldownMs)
  const { extracted, currentModel } = await fetchSessionData(sessionID, context, logger, hookInput)

  if (currentModel) {
    setSessionCooldownModel(sessionID, currentModel.providerID, currentModel.modelID)
    markModelCooldown(currentModel.providerID, currentModel.modelID, config.cooldownMs)
    await showToastSafely(context, {
      title: "Model Error",
      message: `${currentModel.providerID}/${currentModel.modelID} failed, switching to fallback`,
      variant: "warning",
      duration: TOAST_DURATION_MS,
    }, logger)
    await logger.info(`Model ${currentModel.providerID}/${currentModel.modelID} in cooldown`, { sessionID })
  }

  if (!extracted) {
    await logger.error("Cannot fallback: no valid user message", { sessionID })
    return
  }

  await abortSession(sessionID, context)
  deleteLargeContextPhase(sessionID)
  const chain = getFallbackChain(config, extracted.info.agent)
  await logger.info(`Immediate fallback chain (${chain.length} models)`, { sessionID })
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", { sessionID, agent: extracted.info.agent })
    return
  }
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

async function handleLargeContextSwitch(
  sessionID: string,
  lcf: NonNullable<FallbackConfig["largeContextFallback"]>,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
  errorMessage: string,
): Promise<boolean> {
  // Guard: already in a large context phase (synchronous check, no await before this)
  const phase = getLargeContextPhase(sessionID)
  if (phase === "pending" || phase === "active" || phase === "summarizing") return false

  const agent = getSessionOriginalAgent(sessionID)
  if (!agent || !isRegisteredAgent(agent)) return false

  // Guard: large model in cooldown — skip switch if model is unreliable
  const parsed = parseModel(lcf.model)
  if (isModelInCooldown(parsed.providerID, parsed.modelID)) return false

  // Set pending phase ATOMICALLY before any await to prevent concurrent switches
  setLargeContextPhase(sessionID, "pending")

  try {
    const original = getOriginalModel(sessionID)
    if (!original) {
      deleteLargeContextPhase(sessionID)
      return false
    }

    const { extracted } = await fetchSessionData(sessionID, context, logger)
    if (!extracted) {
      deleteLargeContextPhase(sessionID)
      return false
    }

    await logger.info("Switching to large context model", {
      sessionID, agent, largeModel: lcf.model,
      fromModel: `${original.providerID}/${original.modelID}`,
      reason: errorMessage,
    })

    // Save current model for restore later
    const currentModel = getCurrentModel(sessionID)
    if (currentModel) {
      setRestoreModel(sessionID, currentModel.providerID, currentModel.modelID)
    }

    // NO revert — all context is preserved. The last assistant response stays in history.
    // Prompt with large model + continuation text to continue from where the small model left off.
    setActiveFallbackParams(sessionID, { providerID: parsed.providerID, modelID: parsed.modelID })
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        agent,
        parts: [{ type: "text" as const, text: LARGE_CONTEXT_CONTINUATION }],
      },
    })

    setLargeContextPhase(sessionID, "active")
    clearLargeModelIdle(sessionID)
    await showToastSafely(context, {
      title: "Extended Context",
      message: `Switched to ${lcf.model} for expanded capacity`,
      variant: "info",
      duration: TOAST_DURATION_MS,
    }, logger)
    return true
  } catch (err) {
    deleteLargeContextPhase(sessionID)
    clearActiveFallbackParams(sessionID)
    deleteRestoreModel(sessionID)
    await logger.error("Failed to switch to large context model", {
      sessionID, largeModel: lcf.model,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

async function handleLargeContextReturn(
  sessionID: string,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const original = getRestoreModel(sessionID) ?? getOriginalModel(sessionID)
  if (!original) {
    await logger.error("Return: no original model found, clearing phase", { sessionID })
    deleteLargeContextPhase(sessionID)
    clearLargeModelIdle(sessionID)
    return
  }

  await logger.info("Return condition: switching back to original model", {
    sessionID, originalModel: `${original.providerID}/${original.modelID}`,
  })

  setLargeContextPhase(sessionID, "summarizing")

  // Trigger compaction using ORIGINAL model to enforce default model's context limit
  try {
    await context.client.session.summarize({
      path: { id: sessionID },
      body: { providerID: original.providerID, modelID: original.modelID },
    })
    await logger.info("Return: compaction triggered for switch-back", { sessionID, model: original })
    // Actual switch-back happens in session.compacted → session.idle when phase=summarizing
  } catch (err) {
    await logger.error("Return: compaction failed", {
      sessionID, error: err instanceof Error ? err.message : String(err),
    })
    deleteLargeContextPhase(sessionID)
    clearLargeModelIdle(sessionID)
  }
}

async function handleLargeContextCompletion(
  sessionID: string,
  lcf: NonNullable<FallbackConfig["largeContextFallback"]>,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const original = getRestoreModel(sessionID) ?? getOriginalModel(sessionID)
  if (!original) {
    await logger.error("Switch-back: no original model found, clearing phase", { sessionID })
    deleteLargeContextPhase(sessionID)
    clearLargeModelIdle(sessionID)
    return
  }

  await logger.info("Large context work done, switching back to original model", {
    sessionID, originalModel: `${original.providerID}/${original.modelID}`,
  })

  try {
    const agent = getSessionOriginalAgent(sessionID) ?? lcf.agents[0]

    // Do NOT revert — compacted summary from the summarizing phase is preserved.
    // Directly prompt original model with RETURN_CONTINUATION to continue from the compacted context.
    setActiveFallbackParams(sessionID, { providerID: original.providerID, modelID: original.modelID })
    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: { providerID: original.providerID, modelID: original.modelID },
        agent,
        parts: [{ type: "text" as const, text: RETURN_CONTINUATION }],
      },
    })

    deleteLargeContextPhase(sessionID)
    deleteRestoreModel(sessionID)
    await showToastSafely(context, {
      title: "Original Model Restored",
      message: `Switched back to ${original.providerID}/${original.modelID}`,
      variant: "info",
      duration: TOAST_DURATION_MS,
    }, logger)
    await logger.info("Switch-back complete", { sessionID, originalModel: `${original.providerID}/${original.modelID}` })
  } catch (err) {
    await logger.error("Switch-back failed", {
      sessionID, error: err instanceof Error ? err.message : String(err),
    })
    deleteLargeContextPhase(sessionID)
    clearActiveFallbackParams(sessionID)
    deleteRestoreModel(sessionID)
    clearLargeModelIdle(sessionID)
  }
}

export async function createPlugin(context: PluginInput): Promise<PluginHooks> {
  const config = loadConfig()
  const logger = createLogger(config.logging)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agentFallbacks: config.agentFallbacks,
    maxRetries: config.maxRetries,
    cooldownMs: config.cooldownMs,
  })

  if (!config.enabled) {
    await logger.info("Plugin disabled via config")
    return {}
  }

  checkForUpdates(currentVersion).then(async (info) => {
    if (!info.hasUpdate) return

    await logger.info(`Update available: ${info.current} → ${info.latest}`)
    await showToastSafely(context, {
      title: "Updating Plugin",
      message: `opencode-auto-fallback ${info.current} → ${info.latest}`,
      variant: "info",
      duration: TOAST_DURATION_MS,
    }, logger)

    const ok = await tryInstallUpdate(info.latest)
    if (ok) {
      await logger.info(`Updated to ${info.latest}`)
      await showToastSafely(context, {
        title: "Plugin Updated",
        message: `opencode-auto-fallback updated to ${info.latest}`,
        variant: "success",
        duration: TOAST_DURATION_MS,
      }, logger)
    } else {
      await logger.warn("Auto-update failed")
      await showToastSafely(context, {
        title: "Update Failed",
        message: `Could not auto-update. Run manually: bun update opencode-auto-fallback`,
        variant: "warning",
        duration: TOAST_DURATION_LONG_MS,
      }, logger)
    }
  }).catch(async (err) => {
    await logger.warn("Update check failed", { error: err instanceof Error ? err.message : String(err) })
  })

  return {
    config: async (input) => {
      const lcf = config.largeContextFallback
      if (!lcf) return
      setRegisteredAgents(lcf.agents.map(a => normalizeAgentName(a)))
      // Capture compaction.reserved before modifying (used as threshold for model switch)
      const existingCompaction = (input as any).compaction
      if (existingCompaction?.reserved !== undefined) {
        setCompactionReserved(existingCompaction.reserved)
        await logger.info("Config: captured compaction.reserved", {
          reserved: existingCompaction.reserved,
        })
      }
      ;(input as any).compaction = existingCompaction || {}
      ;(input as any).compaction.auto = false
      await logger.info("Config: auto-compaction globally disabled (SDK limitation: no per-agent setting)", {
        agents: lcf.agents,
        largeModel: lcf.model,
        note: "Non-registered agents use manual summarize() approximation",
      })
    },
    "chat.params": async (input, output) => {
      // Track the agent for this session (needed by threshold-based large context switch
      // since compacting hook never fires with auto:false).
      // Only save the first REGISTERED agent — system agents like "title" arrive first
      // and must NOT overwrite, but also must NOT become the stored agent.
      if (input.agent && isRegisteredAgent(input.agent) && !getSessionOriginalAgent(input.sessionID)) {
        setSessionOriginalAgent(input.sessionID, input.agent)
      }
      if (input.model) {
        const { changed, previous: prev } = hasModelChanged(
          input.sessionID, input.model.providerID, input.model.id,
        )

        setCurrentModel(input.sessionID, input.model.providerID, input.model.id)

        if (changed) {
          deactivateCooldown(input.sessionID)
          deleteSessionCooldownModel(input.sessionID)
          await logger.info("Model changed, cooldown reset", {
            sessionID: input.sessionID,
            model: `${input.model.providerID}/${input.model.id}`,
            previousModel: prev ? `${prev.providerID}/${prev.modelID}` : "none",
          })
        }

        getOrSetOriginalModel(input.sessionID, input.model.providerID, input.model.id)

        const ctxLimit = input.model.limit.context
        if (ctxLimit !== undefined) {
          const modelKey = `${input.model.providerID}/${input.model.id}`
          setModelContextLimit(modelKey, ctxLimit)
          if (changed) {
            await logger.info("Detected model context limit", {
              sessionID: input.sessionID,
              model: modelKey,
              contextLimit: ctxLimit,
            })
          }
        }

        // Pre-fetch large context fallback model's limit from same provider
        const lcf = config.largeContextFallback
        if (lcf) {
          const lcfParsed = parseModel(lcf.model)
          const lcfKey = `${lcfParsed.providerID}/${lcfParsed.modelID}`
          if (!getModelContextLimit(lcfKey) && lcfParsed.providerID === input.model.providerID && input.provider.info?.models) {
            const largeModel = input.provider.info.models[lcfParsed.modelID]
            if (largeModel?.limit?.context) {
              setModelContextLimit(lcfKey, largeModel.limit.context)
              await logger.info("Pre-fetched large context fallback model limit", {
                sessionID: input.sessionID,
                model: lcfKey,
                contextLimit: largeModel.limit.context,
              })
            }
          }
        }

        // DIAGNOSTIC: Log if this is a fork session — what model is it ACTUALLY running?
        if (getForkTracking(input.sessionID)) {
          const lcfKey = lcf ? `${parseModel(lcf.model).providerID}/${parseModel(lcf.model).modelID}` : "none"
          await logger.info("🔍 FORK SESSION: chat.params", {
            sessionID: input.sessionID,
            actualModel: `${input.model.providerID}/${input.model.id}`,
            actualLimit: ctxLimit ?? "unknown",
            configuredLargeModel: lcfKey,
            isLargeModel: lcf ? `${input.model.providerID}/${input.model.id}` === lcfKey : false,
          })
        }
      }

      // Pre-generation context threshold check
      // session.idle doesn't fire during auto-continue chains, so threshold would never
      // be checked without this proactive check before every generation.
      // Only abort here — do not call handleLargeContextSwitch because the session is
      // mid-generation-preparation; abort + prompt creates a race condition where
      // the abort error is ignored while the switch's prompt fails on the aborted session.
      // The session.idle handler performs the actual switch after the session settles.
      if (!getLargeContextPhase(input.sessionID)) {
        const lcf = config.largeContextFallback
        if (lcf && input.agent && isRegisteredAgent(input.agent)) {
          const threshold = await checkContextThreshold(input.sessionID, context, logger)
          if (threshold.atThreshold) {
            await logger.info("Pre-generation threshold exceeded, aborting", {
              sessionID: input.sessionID,
              usage: threshold.usage,
              limit: threshold.limit,
            })
            try {
              await context.client.session.abort({ path: { id: input.sessionID } })
              await new Promise(resolve => setTimeout(resolve, ABORT_DELAY_MS))
            } catch { /* session may already be idle */ }
            return
          }
        }
      }

      const fallback = getAndClearFallbackParams(input.sessionID)
      if (!fallback) return
      await logger.info("Applying fallback model params", {
        sessionID: input.sessionID,
        model: `${fallback.providerID}/${fallback.modelID}`,
        temperature: fallback.temperature,
        topP: fallback.topP,
        reasoningEffort: fallback.reasoningEffort,
        maxTokens: fallback.maxTokens,
      })
      if (fallback.temperature !== undefined) output.temperature = fallback.temperature
      if (fallback.topP !== undefined) output.topP = fallback.topP
      if (fallback.reasoningEffort !== undefined) {
        output.options.reasoningEffort = fallback.reasoningEffort
      }
      if (fallback.maxTokens !== undefined) {
        output.options.maxTokens = fallback.maxTokens
      }
      if (fallback.thinking !== undefined) {
        output.options.thinking = fallback.thinking
      }
    },
    "experimental.session.compacting": async (input, output) => {
      const phase = getLargeContextPhase(input.sessionID)

      // Path 1: Summarizing for switch-back — append context about original model's limit
      if (phase === "summarizing") {
        const original = getRestoreModel(input.sessionID) ?? getOriginalModel(input.sessionID)
        if (original) {
          const originalLimit = getModelContextLimit(`${original.providerID}/${original.modelID}`)
          output.context.push(originalLimit
            ? `The compacted summary below must fit within ${originalLimit} tokens total because the session will resume on the original model (${original.providerID}/${original.modelID}). Keep the summary concise while preserving: what the user requested, what the large model accomplished, key files changed, decisions made, and current task status.`
            : `The session will resume on the original model (${original.providerID}/${original.modelID}) after compaction. Preserve: user request, large model accomplishments, key files, decisions, and current status. Keep the summary concise.`)
          await logger.info("Compacting: summarizing — appended original model context", {
            sessionID: input.sessionID,
            originalModel: `${original.providerID}/${original.modelID}`,
            originalLimit,
          })
        }
        return
      }

      // Path 2: Large model self-compaction or manual /compact during active phase
      if (phase === "active") {
        const target = getAndClearCompactionTarget(input.sessionID)
        if (target === "large") {
          // Self-compaction — append context about large model's capacity
          const curModel = getCurrentModel(input.sessionID)
          const largeLimit = curModel ? getModelContextLimit(`${curModel.providerID}/${curModel.modelID}`) : undefined
          output.context.push(largeLimit
            ? `The session is running on a large context model with ${largeLimit} token capacity. Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`
            : `Preserve full task context: current work, files involved, decisions made, next steps. Be thorough — this summary may be the only record of prior work.`)
          await logger.info("Compacting: large model self-compaction — appended", {
            sessionID: input.sessionID,
            largeLimit,
          })
        } else {
          // Manual /compact during active phase — append context about original model limit
          // and transition to summarizing phase so the next idle triggers switch-back.
          const original = getRestoreModel(input.sessionID) ?? getOriginalModel(input.sessionID)
          if (original) {
            const originalLimit = getModelContextLimit(`${original.providerID}/${original.modelID}`)
            output.context.push(originalLimit
              ? `The compacted summary must fit within ${originalLimit} tokens because the session will return to the original model (${original.providerID}/${original.modelID}). Produce a concise summary preserving only: the user's original request, key files changed, critical decisions, and current status. Discard verbatim conversation.`
              : `The session will return to the original model (${original.providerID}/${original.modelID}) after compaction. Produce a concise summary preserving: user request, key files, decisions, and status. Discard verbatim conversation.`)
            await logger.info("Compacting: /compact — appended original model context", {
              sessionID: input.sessionID,
              originalModel: `${original.providerID}/${original.modelID}`,
              originalLimit,
            })
          }
          setLargeContextPhase(input.sessionID, "summarizing")
        }
        return
      }

      // Path 3: Fork session — legacy path (overrides prompt & context completely)
      const forkEntry = getForkTracking(input.sessionID)
      if (forkEntry) {
        output.context = []
        output.prompt = forkEntry.lastRequest
          ? `The conversation was compacted. Continue work on: """${forkEntry.lastRequest}"""`
          : "The conversation was compacted. Preserve full task context."
        return
      }

      // Path 4: Non-registered agent — use SDK default compaction as-is
      const agent = getSessionOriginalAgent(input.sessionID)
      if (agent && !isRegisteredAgent(agent)) {
        await logger.info("Compacting: non-registered agent, using default", {
          sessionID: input.sessionID,
        })
        return
      }

      // Path 5: Registered agent with no phase (manual /compact during normal operation)
      // Use default compaction as-is. Our session.summarize() calls are handled in paths 1-2.
      await logger.info("Compacting: fall through to default", { sessionID: input.sessionID })
    },
    "experimental.compaction.autocontinue": async (
      input: { sessionID: string; agent: string },
      output: { enabled: boolean },
    ) => {
      const phase = getLargeContextPhase(input.sessionID)
      // Suppress during model switch transition
      if (phase === "pending") {
        output.enabled = false
        await logger.info("Autocontinue: suppressed (phase=pending)", {
          sessionID: input.sessionID,
        })
        return
      }
      // Suppress for fork sessions
      if (hasActiveFork(input.sessionID) || getForkTracking(input.sessionID)) {
        output.enabled = false
        await logger.info("Autocontinue: suppressed (active fork)", {
          sessionID: input.sessionID,
        })
        return
      }
      // Explicitly enable for large context phases (active/summarizing)
      if (phase === "active" || phase === "summarizing") {
        output.enabled = true
        await logger.info("Autocontinue: enabled (large context phase)", {
          sessionID: input.sessionID, phase,
        })
      }
      // No-phase sessions: leave at SDK default (should be true)
    },
    event: async ({ event }) => {
      if (event.type === "session.error") {
        const props = event.properties as {
          sessionID?: string
          error?: {
            name: string
            data: {
              message: string
              statusCode?: number
              isRetryable?: boolean
              providerID?: string
            }
          }
        }
        const sessionID = props.sessionID
        if (!sessionID) {
          await logger.warn("session.error event without sessionID", { event })
          return
        }

        const err = props.error
        if (!err) {
          await logger.info("session.error event without error payload", { sessionID })
          return
        }

        if (err.name === "MessageAbortedError") {
          await logger.info("User-initiated abort, ignoring", { sessionID })
          return
        }

        // Context overflow detection — switch to large model in-place
        if (err.data?.message && isContextOverflowError(err.data.message)) {
          const lcf = config.largeContextFallback
          if (!lcf) {
            // No large context fallback configured — fall through to normal error handling
          } else {
            // Abort the failed session first
            try {
              await context.client.session.abort({ path: { id: sessionID } })
              await new Promise(resolve => setTimeout(resolve, ABORT_DELAY_MS))
            } catch { /* session may already be idle */ }

            const phase = getLargeContextPhase(sessionID)
            const agent = getSessionOriginalAgent(sessionID)

            if (phase === "active") {
              // Active large model overflow: self-compact with large model
              const lcfParsed = parseModel(lcf.model)
              setCompactionTarget(sessionID, "large")
              try {
                await context.client.session.summarize({
                  path: { id: sessionID },
                  body: { providerID: lcfParsed.providerID, modelID: lcfParsed.modelID },
                })
              } catch { clearCompactionTarget(sessionID) }
              return
            }

            if (agent && isRegisteredAgent(agent)) {
              // Registered agent overflow: try switch to large model
              const switched = await handleLargeContextSwitch(sessionID, lcf, context, logger, err.data.message)
              if (switched) return
            } else {
              // Non-registered agent overflow: manual compact as auto-compaction approximation
              const curModel = getCurrentModel(sessionID)
              await logger.info("Error: context overflow for non-registered agent, manual compact", { sessionID })
              try {
                await context.client.session.summarize({
                  path: { id: sessionID },
                  ...(curModel ? { body: { providerID: curModel.providerID, modelID: curModel.modelID } } : {}),
                })
              } catch { /* fall through to normal error handling */ }
              return
            }
            // Switch failed — fall through to normal error handling
          }
        }

        const isAuthError = err.name === "ProviderAuthError"
        const isModelNotFoundError =
          err.name === "ProviderModelNotFoundError" ||
          err.data.message?.includes("Model not found")
        const statusCode: number | undefined = err.data.statusCode
        const isRetryable: boolean | undefined = (isAuthError || isModelNotFoundError) ? false : err.data.isRetryable

        await logger.info("session.error detected", {
          sessionID,
          errorName: err.name,
          statusCode,
          isRetryable,
          message: err.data.message,
        })

        // Model-aware cooldown: allow through if the current model differs from the one that triggered cooldown
        const cooldownActive = isCooldownActive(sessionID)
        if (cooldownActive) {
          const currentModel = getCurrentModel(sessionID)
          const cooldownModel = getSessionCooldownModel(sessionID)
          if (currentModel && cooldownModel &&
              (currentModel.providerID !== cooldownModel.providerID ||
               currentModel.modelID !== cooldownModel.modelID)) {
            await logger.info("Model changed during cooldown, allowing error through", {
              sessionID,
              currentModel,
              cooldownModel,
            })
          } else {
            await logger.info("session.error during cooldown, ignoring", { sessionID })
            return
          }
        }

        const decision = classifyError(statusCode, isRetryable, false)

        if (decision.action === "immediate") {
          await logger.info("Immediate error via session.error", {
            sessionID,
            httpStatus: decision.httpStatus,
            isRetryable: decision.isRetryable,
          })
          await handleImmediate(sessionID, config, logger, context)
          return
        }

        if (decision.action === "retry") {
          await logger.info("Retryable error via session.error", {
            sessionID,
            httpStatus: decision.httpStatus,
            isRetryable: decision.isRetryable,
          })
          await handleRetry(sessionID, config, logger, context)
        }
      }
      if (event.type === "session.compacted") {
        const props = event.properties as { sessionID: string }
        const phase = getLargeContextPhase(props.sessionID)
        await logger.info("Compacted event received", {
          sessionID: props.sessionID,
          phase,
        })

        // After summarizing-phase compaction completes, the next idle triggers handleLargeContextCompletion.
        // The compacting hook already set the correct prompt.
        if (phase === "summarizing") {
          await logger.info("Compacted: summarizing complete, next idle will switch back", {
            sessionID: props.sessionID,
          })
          return
        }

        // Large model self-compaction: phase stays "active", next idle checks threshold again
        if (phase === "active") {
          await logger.info("Compacted: large model compaction complete, continuing", {
            sessionID: props.sessionID,
          })
          return
        }
      }
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID: string }
        const phase = getLargeContextPhase(props.sessionID)
        const lcf = config.largeContextFallback
        let agent = getSessionOriginalAgent(props.sessionID)

        // Recover agent if missing (plugin restart) or not registered (e.g. overwritten by "title")
        if (lcf && (!agent || (agent && !isRegisteredAgent(agent)))) {
          const previousAgent = agent
          try {
            const { extracted, messages } = await fetchSessionData(props.sessionID, context, logger)
            let recovered: string | undefined
            // Prefer extractUserParts result if it returns a registered agent
            if (extracted?.info?.agent && isRegisteredAgent(extracted.info.agent)) {
              recovered = extracted.info.agent
            } else {
              // Fallback: scan all user messages for a registered agent
              const found = [...messages].reverse()
                .find(m => m.info.role === "user" && m.info.agent && isRegisteredAgent(m.info.agent))
              recovered = found?.info?.agent
            }
            if (recovered) {
              agent = recovered
              setSessionOriginalAgent(props.sessionID, recovered)
              await logger.info("Idle: recovered agent", {
                sessionID: props.sessionID, agent: recovered, previousAgent,
              })
            }
          } catch {
            await logger.info("Idle: failed to recover agent", { sessionID: props.sessionID })
          }
        }

        // Phase: Normal / No phase — threshold check for model switch or manual compaction
        if (!phase) {
          // Fork result injection (legacy path)
          const forkEntry = getForkTracking(props.sessionID)
          if (forkEntry && forkEntry.status === "running") {
            await injectForkResult(props.sessionID, forkEntry.mainSessionID, forkEntry.agent, context, logger)
            return
          }

          if (!lcf || !agent) return

          const thresholdResult = await checkContextThreshold(props.sessionID, context, logger)
          if (!thresholdResult.atThreshold) return

          if (isRegisteredAgent(agent)) {
            await logger.info("Idle: registered agent at threshold, checking guards", {
              sessionID: props.sessionID, agent,
              usage: thresholdResult.usage, limit: thresholdResult.limit,
            })
            // Registered agent: switch to large context model
            const parsedModel = parseModel(lcf.model)
            const curModel = getCurrentModel(props.sessionID)
            if (curModel) {
              // Guard: already on large model
              if (curModel.providerID === parsedModel.providerID && curModel.modelID === parsedModel.modelID) {
                await logger.info("Idle: guard — already on large model", {
                  sessionID: props.sessionID, model: `${curModel.providerID}/${curModel.modelID}`,
                })
                return
              }
              // Guard: large model in cooldown
              if (isModelInCooldown(parsedModel.providerID, parsedModel.modelID)) {
                await logger.info("Idle: guard — large model in cooldown", {
                  sessionID: props.sessionID, model: lcf.model,
                })
                return
              }
              // Guard: context window ratio
              const largeLimit = getModelContextLimit(`${parsedModel.providerID}/${parsedModel.modelID}`)
              if (largeLimit && shouldSkipLargeContextFallback(thresholdResult.limit, largeLimit, lcf.minContextRatio ?? 0.1)) {
                await logger.info("Idle: guard — context window ratio too small", {
                  sessionID: props.sessionID, currentLimit: thresholdResult.limit, largeLimit, minRatio: lcf.minContextRatio ?? 0.1,
                })
                return
              }
            }
            await logger.info("Idle: all guards passed, switching to large model", {
              sessionID: props.sessionID, largeModel: lcf.model,
            })
            const switched = await handleLargeContextSwitch(props.sessionID, lcf, context, logger, `Context at ${((thresholdResult.usage / thresholdResult.limit) * 100).toFixed(1)}%`)
            await logger.info("Idle: large context switch result", {
              sessionID: props.sessionID, success: switched,
            })
          } else {
            // Non-registered agent: manually compact to preserve default compaction behavior
            const curModel = getCurrentModel(props.sessionID)
            await logger.info("Idle: non-registered agent threshold reached, triggering manual compact", {
              sessionID: props.sessionID, agent,
            })
            await context.client.session.summarize({
              path: { id: props.sessionID },
              ...(curModel ? { body: { providerID: curModel.providerID, modelID: curModel.modelID } } : {}),
            })
          }
          return
        }

        // Phase: "pending" — model switch in progress, wait
        if (phase === "pending") {
          return
        }

        // Phase: "active" — on large model, check return condition or self-compaction
        if (phase === "active") {
          if (!lcf) {
            deleteLargeContextPhase(props.sessionID)
            clearLargeModelIdle(props.sessionID)
            return
          }

          const hasChildren = await hasActiveChildren(props.sessionID, context)

          // Priority 1: Check return condition (idle + no active children)
          if (!hasChildren) {
            // Check if auto-continue might still be in progress by examining last response for tool calls
            let autoContinuePending = false
            try {
              const msgResp = await context.client.session.messages({ path: { id: props.sessionID } })
              const raw = (msgResp.data ?? []) as Array<{ info: { role: string }; parts: Array<{ type: string; state?: { status: string } }> }>
              const lastAsst = [...raw].reverse().find(m => m.info.role === "assistant")
              if (lastAsst) {
                // Only block if tool parts are still pending/running (auto-continue will fire to complete them)
                // Session.idle implies all steps are finished, so step-start alone doesn't indicate pending work
                autoContinuePending = lastAsst.parts.some(
                  p => p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running")
                )
              }
            } catch { /* safe default: assume no auto-continue pending */ }

            if (!autoContinuePending) {
              await logger.info("Idle: return condition met (no children, no pending tools)", {
                sessionID: props.sessionID,
              })
              clearLargeModelIdle(props.sessionID)
              await handleLargeContextReturn(props.sessionID, context, logger)
              return
            }
            await logger.info("Idle: return waiting —pending tool calls in last response", {
              sessionID: props.sessionID,
            })
          }

          // Priority 2: Return condition NOT met — check if large model needs self-compaction
          const largeThreshold = await checkContextThreshold(props.sessionID, context, logger)
          if (largeThreshold.atThreshold) {
            await logger.info("Idle: large model context full, triggering manual compact", {
              sessionID: props.sessionID,
            })
            const lcfParsed = parseModel(lcf.model)
            setCompactionTarget(props.sessionID, "large")
            try {
              await context.client.session.summarize({
                path: { id: props.sessionID },
                body: { providerID: lcfParsed.providerID, modelID: lcfParsed.modelID },
              })
            } catch {
              clearCompactionTarget(props.sessionID)
              await logger.info("Idle: self-compaction failed, cleared compactionTarget", {
                sessionID: props.sessionID,
              })
            }
            return
          }
          return
        }

        // Phase: "summarizing" — compaction done, complete switch-back
        if (phase === "summarizing" && lcf) {
          await handleLargeContextCompletion(props.sessionID, lcf, context, logger)
          return
        }
      }
      if (event.type === "session.status") {
        const props = event.properties as {
          sessionID: string
          status: {
            type: "idle" | "retry" | "busy"
            attempt?: number
            message?: string
            next?: number
          }
        }

        // Log session status transitions for auto-continue cycle tracking
        const statusType = props.status.type
        if (statusType === "busy" || statusType === "idle") {
          const phase = getLargeContextPhase(props.sessionID)
          const agent = getSessionOriginalAgent(props.sessionID)
          await logger.info("Session status: " + statusType, {
            sessionID: props.sessionID,
            phase: phase ?? "none",
            agent: agent ?? "unknown",
          })
        }

        if (props.status.type === "retry" && props.status.message) {
          if (isPermanentRateLimitMessage(props.status.message)) {
            if (isCooldownActive(props.sessionID)) {
              await logger.info("Permanent rate-limit during cooldown, ignoring", { sessionID: props.sessionID })
              return
            }

            await logger.info("Permanent rate-limit detected, falling back immediately", {
              sessionID: props.sessionID,
              message: props.status.message,
            })

            await abortSession(props.sessionID, context)
            await handleImmediate(props.sessionID, config, logger, context)
            return
          }

          if (isTransientErrorMessage(props.status.message)) {
            const attempt = props.status.attempt ?? 1

            if (attempt <= config.maxRetries) {
              await logger.info("Allowing opencode retry within maxRetries", {
                sessionID: props.sessionID,
                attempt,
                maxRetries: config.maxRetries,
                message: props.status.message,
              })
              return
            }

            await logger.info("Transient rate-limit retries exhausted, falling back", {
              sessionID: props.sessionID,
              message: props.status.message,
              attempt,
              maxRetries: config.maxRetries,
              cooldownActive: isCooldownActive(props.sessionID),
            })

            if (isCooldownActive(props.sessionID)) {
              await logger.info("Retry event during cooldown, ignoring", { sessionID: props.sessionID })
              return
            }

            await abortSession(props.sessionID, context)
            await handleImmediate(props.sessionID, config, logger, context)
            return
          }
        }

        if (props.status.type === "idle" && resetIfExpired(props.sessionID)) {
          const removed = cleanupExpired()
          await logger.info("Cooldown expired, state reset", { sessionID: props.sessionID, expiredCooldowns: removed })
        }
      }
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          removeSession(props.info.id)
          cleanupSession(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
      }
    },
  }
}

export const _forTesting = {
  handleRetry,
  handleImmediate,
  tryFallbackChain,
  showToastSafely,
  revertAndPrompt,
  shouldSkipLargeContextFallback,
  contextWindowFor,
  hasActiveChildren,
  checkContextThreshold,
}

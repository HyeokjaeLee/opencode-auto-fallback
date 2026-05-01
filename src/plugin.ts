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
  WAITING_TOAST_DURATION_MS,
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

function isLargeContextAgent(agent: string | undefined, agents: string[]): boolean {
  if (!agent) return false
  const normalizedAgent = normalizeAgentName(agent)
  return agents.some(configuredAgent => normalizeAgentName(configuredAgent) === normalizedAgent)
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
  const agent = getSessionOriginalAgent(sessionID)
  if (!agent || !isLargeContextAgent(agent, lcf.agents)) return false

  // Prevent infinite loop — already in large model mode
  const phase = getLargeContextPhase(sessionID)
  if (phase === "active" || phase === "summarizing") return false

  const parsed = parseModel(lcf.model)
  const original = getOriginalModel(sessionID)
  if (!original) return false

  const { extracted } = await fetchSessionData(sessionID, context, logger)
  if (!extracted) return false

  await logger.info("Context overflow: switching to large model in-place", {
    sessionID, agent, largeModel: lcf.model,
    fromModel: `${original.providerID}/${original.modelID}`,
    error: errorMessage,
  })

  // Capture the current model to restore later (not getOriginalModel which is first-ever)
  const currentModel = getCurrentModel(sessionID)
  if (currentModel) {
    setRestoreModel(sessionID, currentModel.providerID, currentModel.modelID)
  }

  await abortSession(sessionID, context)

  setLargeContextPhase(sessionID, "active")
  // Apply the large model's params (temperature, etc.) via fallback params
  setActiveFallbackParams(sessionID, { providerID: parsed.providerID, modelID: parsed.modelID })

  const ok = await revertAndPrompt(
    sessionID, agent, extracted.parts, extracted.info.id,
    { providerID: parsed.providerID, modelID: parsed.modelID },
    logger, context,
  )

  if (ok) {
    await showToastSafely(context, {
      title: "Context Overflow",
      message: `Switched to ${lcf.model} for extended context`,
      variant: "info",
      duration: TOAST_DURATION_MS,
    }, logger)
  } else {
    deleteLargeContextPhase(sessionID)
    await logger.error("Failed to switch to large context model", { sessionID, largeModel: lcf.model })
  }
  return ok
}

const SUMMARIZE_TIMEOUT_MS = 60_000

async function handleLargeContextCompletion(
  sessionID: string,
  _lcf: NonNullable<FallbackConfig["largeContextFallback"]>,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const original = getRestoreModel(sessionID) ?? getOriginalModel(sessionID)
  if (!original) return

  await logger.info("Large context work done, compacting for switch-back", {
    sessionID, originalModel: `${original.providerID}/${original.modelID}`,
  })

  setLargeContextPhase(sessionID, "summarizing")
  try {
    await context.client.session.summarize({
      path: { id: sessionID },
      body: { providerID: original.providerID, modelID: original.modelID },
    })
  } catch (err) {
    await logger.error("Summarize failed during switch-back", {
      sessionID, error: err instanceof Error ? err.message : String(err),
    })
    deleteLargeContextPhase(sessionID)
  }

  // If session.compacted doesn't fire within the timeout, clean up
  setTimeout(() => {
    const phase = getLargeContextPhase(sessionID)
    if (phase === "summarizing") {
      deleteLargeContextPhase(sessionID)
      logger.warn("Summarize timeout: phase cleaned up", { sessionID })
    }
  }, SUMMARIZE_TIMEOUT_MS)
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
    "chat.params": async (input, output) => {
      // Track the agent for this session (needed by threshold-based large context switch
      // since compacting hook never fires with auto:false)
      if (input.agent) {
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
      await logger.info("Compacting hook fired", { sessionID: input.sessionID })

      // ---- Summarizing phase: compacting to switch back to original model ----
      if (getLargeContextPhase(input.sessionID) === "summarizing") {
        output.prompt = "The conversation was handed off to a large context model due to context overflow. The large model completed the work. Preserve the key results below:\n\n- What the user requested\n- What the large model accomplished\n- Key files changed or decisions made\n- Current task status\n\nFormat as a clear summary so the original model can continue seamlessly."
        await logger.info("Compacting: custom prompt for summarizing phase (switch-back)", {
          sessionID: input.sessionID,
        })
        return
      }

      // ---- Fork session: replace compaction prompt with continuation instruction ----
      const forkEntry = getForkTracking(input.sessionID)
      if (forkEntry) {
        const lastRequest = forkEntry.lastRequest
        // Clear default context strings; our prompt is self-contained
        output.context = []
        if (lastRequest) {
          output.prompt = `The conversation context was compacted. The LLM must continue working on the task below.

## Last User Request
"""${lastRequest}"""

## Instructions for the compaction output
- Restate the user's request as shown above
- List any files that were being modified or discussed
- Note the current task status and next steps
- Preserve all details without condensing — this will be the only record of prior work`
        } else {
          output.prompt = "The conversation context was compacted. Preserve the full task context including what was being worked on, what files were involved, and any decisions made. This will be the only record of prior work."
        }
        await logger.info("Compacting: replaced prompt for fork session", {
          sessionID: input.sessionID,
          promptLength: output.prompt.length,
          hasLastRequest: !!lastRequest,
        })
        return
      }

      const lcf = config.largeContextFallback
      if (!lcf) {
        await logger.info("Compacting: no largeContextFallback config, skipping")
        return
      }

      const original = getOriginalModel(input.sessionID)
      if (!original) {
        await logger.info("Compacting: no original model tracked for session", { sessionID: input.sessionID })
        return
      }

      if (getLargeContextPhase(input.sessionID) === "summarizing") {
        await logger.info("Compacting: summarizing phase, letting compaction proceed", { sessionID: input.sessionID })
        return
      }

      // ---- Fast path: local checks before any API call ----

      if (getLargeContextPhase(input.sessionID) === "active") {
        await logger.info("Compacting: large model context full, letting compaction proceed", {
          sessionID: input.sessionID,
        })
        return
      }

      const parsed = parseModel(lcf.model)
      const currentModel = getCurrentModel(input.sessionID)
      const isLargeModel = currentModel?.providerID === parsed.providerID && currentModel?.modelID === parsed.modelID

      if (isLargeModel) {
        await logger.info("Compacting: already using large model, skipping", {
          sessionID: input.sessionID, largeModel: `${parsed.providerID}/${parsed.modelID}`,
        })
        return
      }

      if (isModelInCooldown(parsed.providerID, parsed.modelID)) {
        await logger.info("Compacting: large context model in cooldown, falling through to default", {
          sessionID: input.sessionID, largeModel: lcf.model,
        })
        return
      }

      if (hasActiveFork(input.sessionID)) {
        await logger.info("Compacting: active fork exists, skipping", {
          sessionID: input.sessionID,
        })
        return
      }

      const effectiveCurrent = currentModel ?? original
      const currentWindow = contextWindowFor(effectiveCurrent)
      const largeWindow = contextWindowFor(parsed)
      if (currentWindow !== undefined && largeWindow !== undefined &&
        shouldSkipLargeContextFallback(currentWindow, largeWindow, lcf.minContextRatio ?? 0.1)
      ) {
        await logger.info("Compacting: context window difference too small, skipping large context fallback", {
          sessionID: input.sessionID,
          currentModel: `${effectiveCurrent.providerID}/${effectiveCurrent.modelID}`,
          largeModel: lcf.model,
          currentWindow,
          largeWindow,
        })
        return
      }

      // ---- API call — only when all fast-path checks pass ----

      const { extracted } = await fetchSessionData(input.sessionID, context, logger)
      if (!extracted) {
        await logger.info("Compacting: no extracted user message", { sessionID: input.sessionID })
        return
      }

      // Use the originally tracked agent if available, falling back to extracted info
      // (extracted.info.agent may point to a synthetic "Continue" message with wrong agent)
      const agent = getSessionOriginalAgent(input.sessionID) ?? extracted.info.agent
      if (!agent) {
        await logger.info("Compacting: no agent found for session", { sessionID: input.sessionID })
        return
      }
      if (!isLargeContextAgent(agent, lcf.agents)) {
        await logger.info("Compacting: agent not in largeContextFallback.agents", { sessionID: input.sessionID, agent, agents: lcf.agents })
        return
      }

      await logger.info("Compacting: switching to large context model in-place", {
        sessionID: input.sessionID, agent, largeModel: lcf.model,
        fromModel: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "unknown",
      })
      setSessionOriginalAgent(input.sessionID, agent)

      const switched = await handleLargeContextSwitch(
        input.sessionID, lcf, context, logger,
        `Compaction triggered at context limit`,
      )

      if (switched) return

      // Switch failed — let normal compaction proceed as fallback.
      await logger.warn("Compacting: switch failed, falling back to default compaction", {
        sessionID: input.sessionID,
      })
    },
    "experimental.compaction.autocontinue": async (
      input: { sessionID: string; agent: string },
      output: { enabled: boolean },
    ) => {
      const phase = getLargeContextPhase(input.sessionID)
      // Suppress auto-continue during large model switch phases
      if (phase === "active" || phase === "summarizing") {
        output.enabled = false
        await logger.info("Autocontinue: suppressed (large context phase)", {
          sessionID: input.sessionID, phase,
        })
        return
      }
      // Suppress auto-continue for fork sessions
      if (hasActiveFork(input.sessionID) || getForkTracking(input.sessionID)) {
        output.enabled = false
        await logger.info("Autocontinue: suppressed (active fork in progress)", {
          sessionID: input.sessionID,
        })
      }
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
          if (lcf) {
            const switched = await handleLargeContextSwitch(sessionID, lcf, context, logger, err.data.message)
            if (switched) return
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
        await logger.info("Compacted event received", { sessionID: props.sessionID })
        if (getForkTracking(props.sessionID)) {
          await logger.info("🔍 FORK SESSION: was compacted", {
            sessionID: props.sessionID,
          })
        }
        const lcf = config.largeContextFallback
        if (!lcf) {
          await logger.info("Compacted: no largeContextFallback config, skipping", { sessionID: props.sessionID })
          return
        }

        // Use restore model (captured at switch time) if available, fall back to first-ever model
        const original = getRestoreModel(props.sessionID) ?? getOriginalModel(props.sessionID)
        if (!original) {
          await logger.info("Compacted: no model to restore for session", { sessionID: props.sessionID })
          return
        }

        // If there's an active fork, inject a waiting notification and skip
        // model switching. This check comes before the phase check because
        // session.idle may have already cleared the phase.
        const activeFork = hasActiveFork(props.sessionID)
        if (activeFork) {
          await logger.info("Compacted: active fork in progress, main session waits for fork result", {
            sessionID: props.sessionID,
          })
          await showToastSafely(context, {
            title: "Processing with Extended Context",
            message: "A sub-agent is handling your last request with extended context. The session will resume automatically once it's complete.",
            variant: "info",
            duration: WAITING_TOAST_DURATION_MS,
          }, logger)
          return
        }

        const phase = getLargeContextPhase(props.sessionID)
        if (phase !== "active" && phase !== "summarizing") {
          await logger.info("Compacted: not in large context phase, skipping", { sessionID: props.sessionID, phase: phase ?? "none" })
          return
        }

        // "active" without "summarizing" means compaction fired after our switch.
        // Trigger the completion (summarize + switch-back) instead of just cleaning up.
        if (phase === "active") {
          await logger.info("Compacted: triggering switch-back after compaction", {
            sessionID: props.sessionID,
          })
          if (lcf) {
            await handleLargeContextCompletion(props.sessionID, lcf, context, logger)
          } else {
            deleteLargeContextPhase(props.sessionID)
          }
          return
        }

        deleteLargeContextPhase(props.sessionID)

        const { extracted } = await fetchSessionData(props.sessionID, context, logger)
        if (!extracted) {
          await logger.info("Compacted: no extracted user message", { sessionID: props.sessionID })
          return
        }

        // Use the originally tracked agent name, not extracted.info.agent
        // (which may point to a synthetic "Continue" message with a wrong agent)
        const agent = getSessionOriginalAgent(props.sessionID) ?? extracted.info.agent
        if (!isLargeContextAgent(agent, lcf.agents)) {
          await logger.info("Compacted: agent not in largeContextFallback.agents", { sessionID: props.sessionID, agent, agents: lcf.agents })
          return
        }

        await logger.info("Compacted: switching back to original model after large context", {
          sessionID: props.sessionID, original,
        })
        const ok = await revertAndPrompt(
          props.sessionID, agent, extracted.parts, extracted.info.id,
          original, logger, context,
        )
        if (!ok) {
          await logger.error("Compacted: failed to switch back to original model", { sessionID: props.sessionID, original })
          return
        }
        await showToastSafely(context, {
          title: "Original Model Restored",
          message: `Switched back to ${original.providerID}/${original.modelID}`,
          variant: "info",
          duration: TOAST_DURATION_MS,
        }, logger)
      }
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID: string }

        // ---- Threshold-based context switch (before large model phase) ----
        const sessionPhase = getLargeContextPhase(props.sessionID)
        const lcf = config.largeContextFallback
        if (lcf && sessionPhase !== "active" && sessionPhase !== "summarizing" && !hasActiveFork(props.sessionID)) {
          try {
            const msgResp = await context.client.session.messages({ path: { id: props.sessionID } })
            const raw = (msgResp.data ?? []) as Array<{ info: { role: string; tokens?: { input: number; output?: number } } }>
            const lastAsst = [...raw].reverse().find(m => m.info.role === "assistant")
            const tokensInput = lastAsst?.info?.tokens?.input
            const tokensOutput = lastAsst?.info?.tokens?.output
            if (tokensInput !== undefined && tokensInput !== null) {
              const parsed = parseModel(lcf.model)
              const curModel = getCurrentModel(props.sessionID)
              const agent = getSessionOriginalAgent(props.sessionID)
              if (curModel && agent && isLargeContextAgent(agent, lcf.agents)) {
                // Guard: already on large model
                if (curModel.providerID === parsed.providerID && curModel.modelID === parsed.modelID) {
                  return
                }
                // Guard: large model in cooldown
                if (isModelInCooldown(parsed.providerID, parsed.modelID)) {
                  return
                }
                const modelKey = `${curModel.providerID}/${curModel.modelID}`
                const limit = getModelContextLimit(modelKey)
                const largeModelKey = `${parsed.providerID}/${parsed.modelID}`
                const largeLimit = getModelContextLimit(largeModelKey)
                // Guard: context window ratio
                if (limit && largeLimit && shouldSkipLargeContextFallback(limit, largeLimit, lcf.minContextRatio ?? 0.1)) {
                  return
                }
                if (limit) {
                  const usage = tokensInput + (tokensOutput ?? 0)
                  const ratio = usage / limit
                  await logger.info("Idle: context ratio", {
                    sessionID: props.sessionID,
                    tokensInput, tokensOutput,
                    usage, limit,
                    ratio: `${(ratio * 100).toFixed(1)}%`,
                    exceed: ratio >= 0.80,
                  })
                  if (ratio >= 0.80) {
                    const switched = await handleLargeContextSwitch(
                      props.sessionID, lcf, context, logger,
                      `Context at ${(ratio * 100).toFixed(1)}% (${usage}/${limit})`,
                    )
                    if (switched) return
                  }
                }
              }
            }
          } catch (err) {
            await logger.info("Idle: fetch/parse error in threshold check", {
              sessionID: props.sessionID,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        if (sessionPhase === "active") {
          if (lcf) {
            await handleLargeContextCompletion(props.sessionID, lcf, context, logger)
          } else {
            deleteLargeContextPhase(props.sessionID)
          }
        }

        const forkEntry = getForkTracking(props.sessionID)
        if (forkEntry && forkEntry.status === "running") {
          await injectForkResult(props.sessionID, forkEntry.mainSessionID, forkEntry.agent, context, logger)
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
  isLargeContextAgent,
  shouldSkipLargeContextFallback,
}

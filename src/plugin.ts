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
import { classifyError, isTransientErrorMessage, isPermanentRateLimitMessage } from "./decision"
import {
  BACKOFF_BASE_MS,
  ABORT_DELAY_MS,
  REVERT_DELAY_MS,
  TOAST_DURATION_MS,
  TOAST_DURATION_LONG_MS,
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
  getForkByMainSession,
} from "./state/context-state"
import { forkSessionForLargeContext, sendForkPrompt, injectForkResult } from "./session-fork"

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
          if (!getModelContextLimit(lcfKey) && lcfParsed.providerID === input.model.providerID) {
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
    "experimental.session.compacting": async (input, _output) => {
      await logger.info("Compacting hook fired", { sessionID: input.sessionID })
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

      await logger.info("Compacting: switching to large context model via fork", {
        sessionID: input.sessionID, agent, largeModel: lcf.model,
        fromModel: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "unknown",
      })
      setSessionOriginalAgent(input.sessionID, agent)

      // Capture the last user request text to provide context when injecting fork result
      const lastRequest = extracted.parts
        .filter((p): p is PromptPart & { type: "text" } => p.type === "text")
        .map(p => p.text)
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000)

      const forkResult = await forkSessionForLargeContext(
        input.sessionID,
        agent,
        { providerID: parsed.providerID, modelID: parsed.modelID },
        { providerID: original.providerID, modelID: original.modelID },
        context,
        logger,
        lastRequest,
      )

      if (forkResult.ok) {
        setLargeContextPhase(input.sessionID, "active")
        await showToastSafely(context, {
          title: "Large Context Model (forked)",
          message: `Forked to ${lcf.model} for large context`,
          variant: "info",
          duration: TOAST_DURATION_MS,
        }, logger)
        await logger.info("Compacting: fork created successfully", {
          sessionID: input.sessionID,
          forkedSessionID: forkResult.forkedSessionID,
        })
        // Dispatch the fork prompt asynchronously so main session compaction
        // and fork LLM processing run in parallel.
        const forkedSessionID = forkResult.forkedSessionID
        if (forkedSessionID) {
          const trackingEntry = getForkTracking(forkedSessionID)
          if (trackingEntry) {
            sendForkPrompt(trackingEntry, context, logger)
              .catch(err => logger.error("Compacting: async fork prompt failed", {
                forkedSessionID,
                error: String(err),
              }))
          }
        }
        return
      }

      // Fork failed — let normal compaction proceed as if nothing happened.
      await logger.warn("Compacting: fork failed, letting normal compaction proceed", {
        sessionID: input.sessionID, error: forkResult.error,
      })
    },
    "experimental.compaction.autocontinue": async (
      input: { sessionID: string; agent: string },
      output: { enabled: boolean },
    ) => {
      if (hasActiveFork(input.sessionID)) {
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
        // Fork session has completed its initial compaction — send the prompt now.
        const compactedForkEntry = getForkTracking(props.sessionID)
        if (compactedForkEntry && compactedForkEntry.status === "forking") {
          await logger.info("Compacted: fork session compacted, sending prompt", {
            sessionID: props.sessionID,
          })
          await sendForkPrompt(compactedForkEntry, context, logger)
          return
        }
        await logger.info("Compacted event received", { sessionID: props.sessionID })
        const lcf = config.largeContextFallback
        if (!lcf) {
          await logger.info("Compacted: no largeContextFallback config, skipping", { sessionID: props.sessionID })
          return
        }

        const original = getOriginalModel(props.sessionID)
        if (!original) {
          await logger.info("Compacted: no original model tracked for session", { sessionID: props.sessionID })
          return
        }

        const phase = getLargeContextPhase(props.sessionID)
        if (phase !== "active" && phase !== "summarizing") {
          await logger.info("Compacted: not in large context phase, skipping", { sessionID: props.sessionID, phase: phase ?? "none" })
          return
        }

        deleteLargeContextPhase(props.sessionID)

        // If there's an active fork, don't re-prompt the original model.
        // The forked session is already handling the work; main session should wait.
        const activeFork = hasActiveFork(props.sessionID)
        if (activeFork) {
          await logger.info("Compacted: active fork in progress, main session waits for fork result", {
            sessionID: props.sessionID,
          })
          // Inject a waiting notification so the user sees their request is being processed.
          const forkEntry = getForkByMainSession(props.sessionID)
          if (forkEntry) {
            await context.client.session.prompt({
              path: { id: props.sessionID },
              body: {
                agent: forkEntry.agent,
                parts: [{ type: "text", text: "Processing your last request with extended context... The session will resume automatically once it's complete." }],
              },
            })
            await context.client.session.abort({ path: { id: props.sessionID } })
            await logger.info("Compacted: waiting notification injected, main session aborted", {
              sessionID: props.sessionID,
            })
          }
          return
        }

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

        await logger.info("Compacted: switching back to original model", {
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
        // Fork session is idle after creation (no compaction needed) — send prompt.
        const idleForkEntry = getForkTracking(props.sessionID)
        if (idleForkEntry && idleForkEntry.status === "forking") {
          await logger.info("Idle: fork session ready, sending prompt", {
            sessionID: props.sessionID,
          })
          await sendForkPrompt(idleForkEntry, context, logger)
          return
        }
        const phase = getLargeContextPhase(props.sessionID)
        if (phase === "active") {
          await logger.info("Idle: large model finished, cleaning up phase (no compact triggered)", {
            sessionID: props.sessionID,
          })
          deleteLargeContextPhase(props.sessionID)
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

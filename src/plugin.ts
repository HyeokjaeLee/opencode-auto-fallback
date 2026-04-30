import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FallbackConfig, FallbackModel } from "./types"
import { getFallbackChain, loadConfig, normalizeAgentName, parseModel } from "./config"
import { classifyError, isRateLimitMessage } from "./decision"
import { BACKOFF_BASE_MS } from "./constants"
import { createLogger } from "./log"
import {
  isCooldownActive,
  activateCooldown,
  resetIfExpired,
  removeSession,
  incrementBackoff,
  resetBackoff,
} from "./session-state"
import { markModelCooldown, isModelInCooldown, cleanupExpired } from "./provider-state"
import { checkForUpdates, tryInstallUpdate } from "./update-checker"
import { version as currentVersion } from "../package.json"
import { extractUserParts } from "./message"

const activeFallbackParams = new Map<string, FallbackModel>()

type LargeContextPhase = "active" | "summarizing"
const largeContextSessions = new Map<string, { providerID: string; modelID: string }>()
const largeContextPhase = new Map<string, LargeContextPhase>()

function isLargeContextAgent(agent: string | undefined, agents: string[]): boolean {
  if (!agent) return false
  const normalizedAgent = normalizeAgentName(agent)
  return agents.some(configuredAgent => normalizeAgentName(configuredAgent) === normalizedAgent)
}

function setActiveFallbackParams(sessionID: string, model: FallbackModel): void {
  activeFallbackParams.set(sessionID, model)
}

function getAndClearFallbackParams(sessionID: string): FallbackModel | undefined {
  const params = activeFallbackParams.get(sessionID)
  activeFallbackParams.delete(sessionID)
  return params
}

async function showToastSafely(
  context: PluginInput,
  body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number },
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    await (context.client as any).tui?.showToast({ body })
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
  const messages = (messagesResponse.data ?? []) as {
    info: { id: string; role: string; sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }
    parts: any[]
  }[]
  let extracted = extractUserParts(messages as any)
  if (!extracted) {
    await logger.info("No user parts found (non-synthetic), retrying with synthetic allowed", { sessionID })
    extracted = extractUserParts(messages as any, { allowSynthetic: true })
  }
  const lastAssistant = [...messages].reverse().find(m => m.info.role === "assistant")
  const currentModel = lastAssistant?.info.model ?? hookInput?.model ?? largeContextSessions.get(sessionID)
  return { messages, extracted, currentModel }
}

async function abortSession(sessionID: string, context: PluginInput) {
  await context.client.session.abort({ path: { id: sessionID } })
  await new Promise(resolve => setTimeout(resolve, 300))
}

async function revertAndPrompt(
  sessionID: string,
  agent: string | undefined,
  parts: any[],
  messageID: string,
  model: FallbackModel,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
): Promise<boolean> {
  try {
    setActiveFallbackParams(sessionID, model)
    await context.client.session.revert({ path: { id: sessionID }, body: { messageID } })
    await new Promise(resolve => setTimeout(resolve, 500))
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
  parts: any[],
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
        duration: 5000,
      }, logger)
      return true
    }
  }
  await showToastSafely(context, {
    title: "Fallback Failed",
    message: "All fallback models exhausted",
    variant: "error",
    duration: 5000,
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
      duration: 5000,
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
    markModelCooldown(currentModel.providerID, currentModel.modelID, config.cooldownMs)
    await showToastSafely(context, {
      title: "Model Error",
      message: `${currentModel.providerID}/${currentModel.modelID} failed, switching to fallback`,
      variant: "warning",
      duration: 5000,
    }, logger)
    await logger.info(`Model ${currentModel.providerID}/${currentModel.modelID} in cooldown`, { sessionID })
  }

  if (!extracted) {
    await logger.error("Cannot fallback: no valid user message", { sessionID })
    return
  }

  await abortSession(sessionID, context)
  const chain = getFallbackChain(config, extracted.info.agent)
  await logger.info(`Immediate fallback chain (${chain.length} models)`, { sessionID })
  if (chain.length === 0) {
    await logger.info("No fallback chain configured for this agent, skipping", { sessionID, agent: extracted.info.agent })
    return
  }
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

function findRetryPart(parts: any[]): any {
  return parts.find((p: any) => p.type === "retry")
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
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
      duration: 5000,
    }, logger)

    const ok = await tryInstallUpdate(info.latest)
    if (ok) {
      await logger.info(`Updated to ${info.latest}`)
      await showToastSafely(context, {
        title: "Plugin Updated",
        message: `opencode-auto-fallback updated to ${info.latest}`,
        variant: "success",
        duration: 5000,
      }, logger)
    } else {
      await logger.warn("Auto-update failed")
      await showToastSafely(context, {
        title: "Update Failed",
        message: `Could not auto-update. Run manually: bun update opencode-auto-fallback`,
        variant: "warning",
        duration: 8000,
      }, logger)
    }
  }).catch(() => {})

  return {
    config: async (input) => {
      if (input.experimental === undefined) {
        (input as any).experimental = {}
      }
      input.experimental!.chatMaxRetries = 0
      // SSE-level retry happens below chat-level and ignores chatMaxRetries.
      // Set sseMaxRetryAttempts to 0 so the SSE client breaks after the first non-200 response,
      // allowing our plugin's session.error handler to take over the fallback logic.
      if ((input.experimental as any).sseMaxRetryAttempts === undefined) {
        (input.experimental as any).sseMaxRetryAttempts = 0
      }
      await logger.info("Disabled opencode built-in retry", {
        chatMaxRetries: input.experimental!.chatMaxRetries,
        sseMaxRetryAttempts: (input.experimental as any).sseMaxRetryAttempts,
        experimentalKeys: Object.keys(input.experimental ?? {}),
      })
    },
    "chat.message": async (input, output) => {
      const partTypes = (output.parts ?? []).map((p: any) => p.type)
      await logger.info("chat.message hook fired", {
        sessionID: input.sessionID,
        partTypes,
        partCount: (output.parts ?? []).length,
      })

      const retryPart = findRetryPart(output.parts)
      if (!retryPart) {
        await logger.info("No retry part found in output.parts — skipping", {
          sessionID: input.sessionID,
          partTypes,
        })
        return
      }

      const statusCode: number | undefined = retryPart.error?.data?.statusCode
      const isRetryable: boolean | undefined = retryPart.error?.data?.isRetryable

      const decision = classifyError(statusCode, isRetryable, isCooldownActive(input.sessionID))

      if (decision.action === "immediate") {
        await logger.info("Immediate error", {
          sessionID: input.sessionID,
          httpStatus: decision.httpStatus,
          isRetryable: decision.isRetryable,
        })
        await handleImmediate(input.sessionID, config, logger, context, input)
        return
      }

      if (decision.action === "retry") {
        await logger.info("Retryable error", {
          sessionID: input.sessionID,
          httpStatus: decision.httpStatus,
          isRetryable: decision.isRetryable,
        })
        await handleRetry(input.sessionID, config, logger, context, input)
      }
    },
    "chat.params": async (input, output) => {
      if (input.model && !largeContextSessions.has(input.sessionID)) {
        largeContextSessions.set(input.sessionID, {
          providerID: input.model.providerID,
          modelID: input.model.id,
        })
        await logger.info("Tracked original model for session", {
          sessionID: input.sessionID,
          model: `${input.model.providerID}/${input.model.id}`,
        })
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
      const lcf = config.largeContextFallback
      if (!lcf) {
        await logger.info("Compacting: no largeContextFallback config, skipping")
        return
      }

      const original = largeContextSessions.get(input.sessionID)
      if (!original) {
        await logger.info("Compacting: no original model tracked for session", { sessionID: input.sessionID })
        return
      }

      if (largeContextPhase.get(input.sessionID) === "summarizing") {
        await logger.info("Compacting: summarizing phase, letting compaction proceed", { sessionID: input.sessionID })
        return
      }

      const { extracted, currentModel, messages } = await fetchSessionData(input.sessionID, context, logger)
      if (!extracted) {
        await logger.info("Compacting: no extracted user message", { sessionID: input.sessionID })
        return
      }

      const agent = extracted.info.agent
      if (!isLargeContextAgent(agent, lcf.agents)) {
        await logger.info("Compacting: agent not in largeContextFallback.agents", { sessionID: input.sessionID, agent, agents: lcf.agents })
        return
      }

      const parsed = parseModel(lcf.model)

      if (largeContextPhase.get(input.sessionID) === "active") {
        await logger.info("Compacting: large model context full, letting compaction proceed", {
          sessionID: input.sessionID, largeModel: `${parsed.providerID}/${parsed.modelID}`,
        })
        return
      }

      if (currentModel?.providerID === original.providerID && currentModel?.modelID === original.modelID) {
        if (isModelInCooldown(parsed.providerID, parsed.modelID)) {
          await logger.info("Compacting: large context model in cooldown, falling through to default", {
            sessionID: input.sessionID, largeModel: lcf.model,
          })
          return
        }

        await logger.info("Compacting: switching to large context model (no compact)", {
          sessionID: input.sessionID, agent, largeModel: lcf.model,
          fromModel: `${original.providerID}/${original.modelID}`,
        })
        await abortSession(input.sessionID, context)
        largeContextPhase.set(input.sessionID, "active")
        const ok = await revertAndPrompt(
          input.sessionID, agent, extracted.parts, extracted.info.id,
          { providerID: parsed.providerID, modelID: parsed.modelID },
          logger, context,
        )
        if (!ok) {
          largeContextPhase.delete(input.sessionID)
          await logger.error("Compacting: failed to switch to large context model", { sessionID: input.sessionID, largeModel: lcf.model })
          return
        }
        await showToastSafely(context, {
          title: "Large Context Model",
          message: `Switched to ${lcf.model} for large context`,
          variant: "info",
          duration: 5000,
        }, logger)
      } else {
        await logger.info("Compacting: model already switched, skipping", {
          sessionID: input.sessionID,
          original: `${original.providerID}/${original.modelID}`,
          current: currentModel ? `${currentModel.providerID}/${currentModel.modelID}` : "unknown",
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

        // ProviderAuthError & model-not-found errors have no statusCode/isRetryable — treat as immediate
        const isAuthError = err.name === "ProviderAuthError"
        const isModelNotFound =
          err.name === "ProviderModelNotFoundError" ||
          err.data.message?.includes("Model not found")
        const statusCode: number | undefined = err.data.statusCode
        const isRetryable: boolean | undefined = (isAuthError || isModelNotFound) ? false : err.data.isRetryable

        await logger.info("session.error detected", {
          sessionID,
          errorName: err.name,
          statusCode,
          isRetryable,
          message: err.data.message,
        })

        const decision = classifyError(statusCode, isRetryable, isCooldownActive(sessionID))

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
        const lcf = config.largeContextFallback
        if (!lcf) {
          await logger.info("Compacted: no largeContextFallback config, skipping", { sessionID: props.sessionID })
          return
        }

        const original = largeContextSessions.get(props.sessionID)
        if (!original) {
          await logger.info("Compacted: no original model tracked for session", { sessionID: props.sessionID })
          return
        }

        const phase = largeContextPhase.get(props.sessionID)
        if (phase !== "active" && phase !== "summarizing") {
          await logger.info("Compacted: not in large context phase, skipping", { sessionID: props.sessionID, phase: phase ?? "none" })
          return
        }

        const { extracted } = await fetchSessionData(props.sessionID, context, logger)
        if (!extracted) {
          await logger.info("Compacted: no extracted user message", { sessionID: props.sessionID })
          return
        }

        const agent = extracted.info.agent
        if (!isLargeContextAgent(agent, lcf.agents)) {
          await logger.info("Compacted: agent not in largeContextFallback.agents", { sessionID: props.sessionID, agent, agents: lcf.agents })
          return
        }

        await logger.info("Compacted: switching back to original model", {
          sessionID: props.sessionID, original,
        })
        largeContextPhase.delete(props.sessionID)
        const ok = await revertAndPrompt(
          props.sessionID, extracted.info.agent, extracted.parts, extracted.info.id,
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
          duration: 5000,
        }, logger)
      }
      if (event.type === "session.idle") {
        const props = event.properties as { sessionID: string }
        const phase = largeContextPhase.get(props.sessionID)
        const lcf = config.largeContextFallback
        if (phase === "active" && lcf) {
          const parsed = parseModel(lcf.model)
          await logger.info("Idle: large model finished, triggering summarize for compact", {
            sessionID: props.sessionID,
          })
          largeContextPhase.set(props.sessionID, "summarizing")
          try {
            await context.client.session.summarize({
              path: { id: props.sessionID },
              body: { providerID: parsed.providerID, modelID: parsed.modelID },
            })
          } catch (err) {
            await logger.warn("Idle: failed to trigger summarize", {
              sessionID: props.sessionID,
              error: err instanceof Error ? err.message : String(err),
            })
            largeContextPhase.delete(props.sessionID)
          }
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
          if (isRateLimitMessage(props.status.message)) {
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

            await logger.info("Rate-limit retries exhausted, falling back", {
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
          largeContextSessions.delete(props.info.id)
          largeContextPhase.delete(props.info.id)
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
  largeContextPhase,
}

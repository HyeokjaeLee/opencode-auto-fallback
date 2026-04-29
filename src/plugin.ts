import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FallbackConfig, FallbackModel } from "./types"
import { getFallbackChain, loadConfig } from "./config"
import { classifyError } from "./decision"
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
import { extractUserParts } from "./message"

const activeFallbackParams = new Map<string, FallbackModel>()

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

async function fetchSessionData(sessionID: string, context: PluginInput) {
  const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
  const messages = (messagesResponse.data ?? []) as {
    info: { id: string; role: string; sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }
    parts: any[]
  }[]
  const extracted = extractUserParts(messages as any)
  const lastAssistant = [...messages].reverse().find(m => m.info.role === "assistant")
  return { messages, extracted, currentModel: lastAssistant?.info.model }
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
) {
  const backoffLevel = incrementBackoff(sessionID)
  const { extracted, currentModel } = await fetchSessionData(sessionID, context)
  if (!extracted || !currentModel) {
    await logger.error("Cannot retry: missing message or model", { sessionID })
    return
  }
  await abortSession(sessionID, context)

  if (backoffLevel <= config.maxRetries) {
    const waitMs = BACKOFF_BASE_MS * Math.pow(2, backoffLevel - 1)
    await logger.info(`Backoff retry ${backoffLevel}/${config.maxRetries} (${waitMs}ms)`, { sessionID })
    await new Promise(resolve => setTimeout(resolve, waitMs))
    const ok = await revertAndPrompt(
      sessionID, extracted.info.agent, extracted.parts, extracted.info.id,
      { providerID: currentModel.providerID, modelID: currentModel.modelID },
      logger, context,
    )
    if (ok) await logger.info("Retry succeeded with same model", { sessionID, backoffLevel })
    return
  }

  resetBackoff(sessionID)
  await showToastSafely(context, {
    title: "Retries Exhausted",
    message: `Switching to fallback after ${config.maxRetries} retries`,
    variant: "warning",
    duration: 5000,
  }, logger)
  const chain = getFallbackChain(config, extracted.info.agent)
  await logger.info(`Retries exhausted (${backoffLevel}), starting fallback chain`, { sessionID })
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

async function handleImmediate(
  sessionID: string,
  config: FallbackConfig,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
) {
  activateCooldown(sessionID, config.cooldownMs)
  const { extracted, currentModel } = await fetchSessionData(sessionID, context)
  if (!extracted) {
    await logger.error("Cannot fallback: no valid user message", { sessionID })
    return
  }
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
  await abortSession(sessionID, context)
  const chain = getFallbackChain(config, extracted.info.agent)
  await logger.info(`Immediate fallback chain (${chain.length} models)`, { sessionID })
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

function hasErrorText(parts: any[]): string {
  for (const part of parts) {
    if (part.type === "text" && part.text) return part.text
  }
  return ""
}

function looksLikeError(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes("error") || lower.includes("failed") || lower.includes("unable")
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

  return {
    "chat.message": async (input, output) => {
      const text = hasErrorText(output.parts)
      if (!text || !looksLikeError(text)) return

      const decision = classifyError(text, isCooldownActive(input.sessionID))

      if (decision.action === "immediate") {
        await logger.info("Immediate error", {
          sessionID: input.sessionID, text: text.slice(0, 200),
          httpStatus: decision.httpStatus, matchedPattern: decision.matchedPattern,
        })
        await handleImmediate(input.sessionID, config, logger, context)
        return
      }

      if (decision.action === "retry") {
        await logger.info("Retryable error", {
          sessionID: input.sessionID, text: text.slice(0, 200),
          httpStatus: decision.httpStatus, matchedPattern: decision.matchedPattern,
        })
        await handleRetry(input.sessionID, config, logger, context)
      }
    },
    "chat.params": async (input, output) => {
      const fallback = getAndClearFallbackParams(input.sessionID)
      if (!fallback) return
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
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = event.properties as { sessionID: string; status: { type: string } }
        if (props.status.type === "idle" && resetIfExpired(props.sessionID)) {
          const removed = cleanupExpired()
          await logger.info("Cooldown expired, state reset", { sessionID: props.sessionID, expiredCooldowns: removed })
        }
      }
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          removeSession(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
      }
    },
  }
}

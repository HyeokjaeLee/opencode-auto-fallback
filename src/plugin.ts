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
import { markProviderBroken, isProviderBroken, clearBrokenProviders } from "./provider-state"
import { extractUserParts } from "./message"

interface SessionStatusProps {
  sessionID: string
  status: {
    type: "idle" | "retry" | "busy"
    attempt?: number
    message?: string
    next?: number
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
    await logger.warn("Prompt failed", {
      sessionID,
      model,
      error: err instanceof Error ? err.message : String(err),
    })
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
    if (isProviderBroken(chain[i].providerID)) {
      await logger.info(`Skipping broken provider ${chain[i].providerID}`, {
        sessionID,
        model: chain[i],
        remaining: chain.length - i - 1,
      })
      continue
    }

    await logger.info(`Trying fallback ${i + 1}/${chain.length}`, { sessionID, model: chain[i] })
    const ok = await revertAndPrompt(sessionID, agent, parts, messageID, chain[i], logger, context)
    if (ok) {
      await logger.info("Fallback chain succeeded", { sessionID, triedCount: i + 1 })
      return true
    }
  }
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

  if (backoffLevel <= config.rateLimitRetries) {
    const waitMs = BACKOFF_BASE_MS * Math.pow(2, backoffLevel - 1)
    await logger.info(`Backoff retry ${backoffLevel}/${config.rateLimitRetries} (${waitMs}ms)`, { sessionID })
    await new Promise(resolve => setTimeout(resolve, waitMs))

    const ok = await revertAndPrompt(
      sessionID, extracted.info.agent, extracted.parts, extracted.info.id,
      { providerID: currentModel.providerID, modelID: currentModel.modelID },
      logger, context,
    )
    if (ok) {
      await logger.info("Retry succeeded with same model", { sessionID, backoffLevel })
    }
    return
  }

  resetBackoff(sessionID)
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
    markProviderBroken(currentModel.providerID)
    await logger.info(`Marked provider ${currentModel.providerID} as broken`, { sessionID })
  }

  await abortSession(sessionID, context)
  const chain = getFallbackChain(config, extracted.info.agent)
  await logger.info(`Immediate fallback chain (${chain.length} models)`, { sessionID })
  await tryFallbackChain(sessionID, chain, extracted.info.agent, extracted.parts, extracted.info.id, logger, context)
}

async function handleIdleStatus(props: SessionStatusProps, logger: ReturnType<typeof createLogger>) {
  if (resetIfExpired(props.sessionID)) {
    clearBrokenProviders()
    await logger.info("Cooldown expired, backoff and provider state reset", { sessionID: props.sessionID })
  }
}

async function handleSessionDeleted(event: { properties: unknown }, logger: ReturnType<typeof createLogger>) {
  const props = event.properties as { info?: { id?: string } }
  if (props.info?.id) {
    removeSession(props.info.id)
    await logger.info("Session cleaned up", { sessionID: props.info.id })
  }
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()
  const logger = createLogger(config.logging)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agentFallbacks: config.agentFallbacks,
    rateLimitRetries: config.rateLimitRetries,
    cooldownMs: config.cooldownMs,
  })

  if (!config.enabled) {
    await logger.info("Plugin disabled via config")
    return {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = event.properties as SessionStatusProps
        if (props.status.type === "retry" && props.status.message) {
          const decision = classifyError(props.status.message, isCooldownActive(props.sessionID))
          if (decision.action === "immediate") {
            await handleImmediate(props.sessionID, config, logger, context)
          }
          if (decision.action === "retry") {
            await handleRetry(props.sessionID, config, logger, context)
          }
        }
        if (props.status.type === "idle") {
          await handleIdleStatus(props, logger)
        }
      }
      if (event.type === "session.deleted") {
        await handleSessionDeleted(event, logger)
      }
    },
  }
}

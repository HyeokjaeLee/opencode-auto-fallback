import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { FallbackConfig } from "./types"
import { getFallbackForAgent, loadConfig } from "./config"
import { createLogger } from "./log"
import { isCooldownActive, activateCooldown, resetIfExpired, removeSession } from "./session-state"
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

function createPatternMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
  }
}

async function handleRetryStatus(
  props: SessionStatusProps,
  config: FallbackConfig,
  logger: ReturnType<typeof createLogger>,
  context: PluginInput,
): Promise<void> {
  const sessionID = props.sessionID

  if (isCooldownActive(sessionID)) {
    await logger.info("Skipping fallback, cooldown active", { sessionID })
    return
  }

  await logger.info("Rate limit detected, switching to fallback", {
    sessionID,
    message: props.status.message,
  })

  activateCooldown(sessionID, config.cooldownMs)

  try {
    await logger.info("Aborting session", { sessionID })
    await context.client.session.abort({ path: { id: sessionID } })
    await new Promise(resolve => setTimeout(resolve, 200))

    await logger.info("Fetching messages", { sessionID })
    const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
    const messages = messagesResponse.data as
      | { info: { id: string; role: string; sessionID: string; agent?: string }; parts: any[] }[]
      | undefined

    if (!messages || messages.length === 0) {
      await logger.error("No messages found in session", { sessionID })
      return
    }

    const extracted = extractUserParts(messages as any)
    if (!extracted) {
      await logger.error("No valid user message found in session", { sessionID })
      return
    }

    const fallbackModel = getFallbackForAgent(config, extracted.info.agent)

    await logger.info("Found last user message", {
      sessionID,
      messageId: extracted.info.id,
      agent: extracted.info.agent,
      fallbackModel,
      totalMessages: messages.length,
    })

    await logger.info("Reverting session", { sessionID, messageId: extracted.info.id })
    const revertResponse = await context.client.session.revert({
      path: { id: sessionID },
      body: { messageID: extracted.info.id },
    })
    await logger.info("Revert completed", {
      sessionID,
      revertStatus: revertResponse.response?.status,
      hasRevertState: !!(revertResponse.data as any)?.revert,
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    await logger.info("Sending prompt with fallback model", {
      sessionID,
      agent: extracted.info.agent,
      model: fallbackModel,
      partsCount: extracted.parts.length,
    })

    await context.client.session.prompt({
      path: { id: sessionID },
      body: {
        model: fallbackModel,
        agent: extracted.info.agent,
        parts: extracted.parts,
      },
    })

    await logger.info("Fallback prompt sent successfully", { sessionID })
  } catch (err) {
    await logger.error("Failed to send fallback prompt", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleIdleStatus(
  props: SessionStatusProps,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (resetIfExpired(props.sessionID)) {
    await logger.info("Cooldown expired, fallback reset", { sessionID: props.sessionID })
  }
}

async function handleSessionDeleted(
  event: { properties: unknown },
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const props = event.properties as { info?: { id?: string } }
  if (props.info?.id) {
    removeSession(props.info.id)
    await logger.info("Session cleaned up", { sessionID: props.info.id })
  }
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()
  const logger = createLogger(config.logging)
  const isRateLimitMessage = createPatternMatcher(config.patterns)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    defaultFallback: config.defaultFallback,
    agentFallbacks: config.agentFallbacks,
    patterns: config.patterns,
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
          if (isRateLimitMessage(props.status.message)) {
            await handleRetryStatus(props, config, logger, context)
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

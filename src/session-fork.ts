import type { PluginInput } from "@opencode-ai/plugin"
import type { FallbackModel, ForkTrackingEntry, ResolvedModel } from "./types"
import { FORK_TIMEOUT_MS, FORK_INJECT_DELAY_MS } from "./constants"
import {
  setForkTracking,
  getForkTracking,
  updateForkStatus,
  setActiveFallbackParams,
} from "./state/context-state"
import { createLogger } from "./log"

export interface ForkResult {
  ok: boolean
  forkedSessionID?: string
  error?: string
}

export async function forkSessionForLargeContext(
  sessionID: string,
  agent: string,
  largeModel: FallbackModel,
  originalModel: ResolvedModel,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
  lastRequest?: string,
): Promise<ForkResult> {
  try {
    const forkResponse = await context.client.session.fork({ path: { id: sessionID } })
    if (!forkResponse.data?.id) {
      await logger.warn("Fork: empty session ID in response", { sessionID })
      return { ok: false, error: "Empty fork response" }
    }

    const forkedSessionID = forkResponse.data.id
    const trackingEntry: ForkTrackingEntry = {
      forkedSessionID,
      mainSessionID: sessionID,
      status: "forking",
      agent,
      largeModel,
      originalModel,
      createdAt: Date.now(),
      lastRequest,
    }
    setForkTracking(trackingEntry)
    await logger.info("Fork: session forked successfully", {
      sessionID,
      forkedSessionID,
      largeModel: `${largeModel.providerID}/${largeModel.modelID}`,
    })

    // Prompt is NOT sent here — it will be sent asynchronously when the fork
    // session's initial compaction completes (detected via session.compacted
    // or session.idle event). This lets the main session's compaction proceed
    // in parallel instead of blocking on the fork's prompt.

    setTimeout(() => {
      const current = getForkTracking(forkedSessionID)
      if (current && (current.status === "forking" || current.status === "running")) {
        updateForkStatus(forkedSessionID, "failed")
        logger.warn("Fork: timeout reached, marking as failed", {
          sessionID,
          forkedSessionID,
          timeoutMs: FORK_TIMEOUT_MS,
        })
      }
    }, FORK_TIMEOUT_MS)

    return { ok: true, forkedSessionID }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await logger.error("Fork: failed to fork session", { sessionID, error: errorMsg })
    return { ok: false, error: errorMsg }
  }
}

export async function sendForkPrompt(
  forkEntry: ForkTrackingEntry,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const { forkedSessionID, agent, largeModel } = forkEntry
  try {
    updateForkStatus(forkedSessionID, "running")
    setActiveFallbackParams(forkedSessionID, largeModel)
    await context.client.session.prompt({
      path: { id: forkedSessionID },
      body: {
        model: { providerID: largeModel.providerID, modelID: largeModel.modelID },
        agent,
        parts: [{ type: "text", text: "Continue the interrupted work from the existing conversation context. If the task still has remaining work, continue it. If the task is complete, report the result without adding unnecessary continuation." }],
      },
    })
    await logger.info("Fork: prompt sent to forked session", { forkedSessionID })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await logger.error("Fork: failed to send prompt to forked session", {
      forkedSessionID,
      error: errorMsg,
    })
    updateForkStatus(forkedSessionID, "failed")
  }
}

export async function injectForkResult(
  forkedSessionID: string,
  mainSessionID: string,
  agent: string | undefined,
  context: PluginInput,
  logger: ReturnType<typeof createLogger>,
): Promise<boolean> {
  try {
    updateForkStatus(forkedSessionID, "injecting")
    await new Promise(resolve => setTimeout(resolve, FORK_INJECT_DELAY_MS))

    const messagesResponse = await context.client.session.messages({ path: { id: forkedSessionID } })
    const raw = (messagesResponse.data ?? []) as Array<{ info: { role: string; id: string; agent?: string }; parts: Array<{ type: string; text?: string }> }>

    const lastAssistant = [...raw].reverse().find(m => m.info.role === "assistant")
    if (!lastAssistant) {
      await logger.warn("Fork: no assistant message found in forked session", { forkedSessionID })
      updateForkStatus(forkedSessionID, "completed")
      return false
    }

    const assistantText = lastAssistant.parts
      .filter(p => p.type === "text")
      .map(p => p.text)
      .filter(Boolean)
      .join("\n")

    if (!assistantText) {
      await logger.warn("Fork: no text content in forked assistant message", { forkedSessionID })
      updateForkStatus(forkedSessionID, "completed")
      return false
    }

    const forkEntry = getForkTracking(forkedSessionID)
    const lastRequest = forkEntry?.lastRequest

    const parts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: "Your conversation context was compacted because it reached its limit." },
    ]
    if (lastRequest) {
      parts.push({ type: "text", text: `\n\nYour last task before compaction was:\n"""\n${lastRequest}\n"""` })
    }
    parts.push({ type: "text", text: `\n\nHere is the result:\n"""\n${assistantText}\n"""` })
    parts.push({ type: "text", text: "\n\nContinue the work based on the result above. Proceed with any remaining steps or follow-ups." })

    await context.client.session.prompt({
      path: { id: mainSessionID },
      body: {
        agent,
        parts,
      },
    })

    updateForkStatus(forkedSessionID, "done")
    await logger.info("Fork: result injected into main session", { mainSessionID, forkedSessionID })
    return true
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    await logger.error("Fork: failed to inject result", {
      forkedSessionID,
      mainSessionID,
      error: errorMsg,
    })
    updateForkStatus(forkedSessionID, "failed")
    return false
  }
}

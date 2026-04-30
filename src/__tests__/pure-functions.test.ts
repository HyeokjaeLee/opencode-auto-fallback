import { describe, it, expect, afterEach } from "vitest"
import { parseModel, getFallbackChain, normalizeAgentName } from "../config"
import { isTransientErrorMessage, isPermanentRateLimitMessage } from "../decision"
import {
  activateCooldown,
  incrementBackoff,
  getBackoffLevel,
  resetBackoff,
  resetIfExpired,
  removeSession,
} from "../session-state"
import { shouldWriteLog } from "../log"
import { extractUserParts } from "../message"
import type { FallbackConfig } from "../types"

describe("parseModel", () => {
  it("parses 'provider/model'", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
  })
  it("no slash", () => expect(parseModel("mymodel")).toEqual({ providerID: "mymodel", modelID: "mymodel" }))
  it("passes through object", () => {
    const obj = { providerID: "google", modelID: "gemini-2.5-flash" }
    expect(parseModel(obj)).toBe(obj)
  })
})

describe("getFallbackChain", () => {
  const config: FallbackConfig = {
    enabled: true,
    defaultFallback: ["anthropic/claude-opus-4-5"],
    agentFallbacks: {
      build: ["anthropic/claude-sonnet-4"],
      oracle: [
        { providerID: "openai", modelID: "gpt-5.5" },
        { providerID: "zai-coding-plan", modelID: "glm-5.1", variant: "high" },
      ],
    },
    cooldownMs: 300000,
    maxRetries: 3,
    logging: false,
  }
  it("agent-specific", () => expect(getFallbackChain(config, "build")).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4" }]))
  it("preserves variant", () => expect(getFallbackChain(config, "oracle")).toEqual([
    { providerID: "openai", modelID: "gpt-5.5" },
    { providerID: "zai-coding-plan", modelID: "glm-5.1", variant: "high" },
  ]))
  it("falls back to default", () => expect(getFallbackChain(config, "unknown")).toEqual([{ providerID: "anthropic", modelID: "claude-opus-4-5" }]))
  it("returns empty when no default and agent not registered", () => {
    const noDefault: FallbackConfig = { ...config, defaultFallback: undefined }
    expect(getFallbackChain(noDefault, "unknown")).toEqual([])
  })
  it("still works for registered agent when no default", () => {
    const noDefault: FallbackConfig = { ...config, defaultFallback: undefined }
    expect(getFallbackChain(noDefault, "build")).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4" }])
  })
  it("preserves new FallbackModel fields", () => {
    const configWithParams: FallbackConfig = {
      ...config,
      agentFallbacks: {
        oracle: [{
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          reasoningEffort: "high",
          temperature: 0.5,
          topP: 0.9,
          maxTokens: 8192,
          thinking: { type: "enabled", budgetTokens: 4096 },
        }],
      },
    }
    const chain = getFallbackChain(configWithParams, "oracle")
    expect(chain[0]).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      reasoningEffort: "high",
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 8192,
      thinking: { type: "enabled", budgetTokens: 4096 },
    })
  })
  it("parses { model: 'provider/model' } shorthand", () => {
    const configShort: FallbackConfig = {
      ...config,
      agentFallbacks: {
        build: [{ model: "openai/gpt-5.5", variant: "high", temperature: 0.7 }],
      },
    }
    const chain = getFallbackChain(configShort, "build")
    expect(chain[0]).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      variant: "high",
      temperature: 0.7,
    })
  })
  it("matches agentFallbacks case-insensitively and ignores whitespace", () => {
    const configWithDisplayName: FallbackConfig = {
      ...config,
      agentFallbacks: {
        "sisyphus-ultraworker": ["opencode-go/deepseek-v4-pro"],
      },
    }
    expect(getFallbackChain(configWithDisplayName, "​Sisyphus - Ultraworker")).toEqual([
      { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
    ])
  })
})

describe("normalizeAgentName", () => {
  it("removes whitespace and zero-width characters before lowercasing", () => {
    expect(normalizeAgentName("​Sisyphus - Ultraworker")).toBe("sisyphus-ultraworker")
  })
})

describe("extractUserParts", () => {
  it("falls back to an earlier user message when the latest user message has no promptable parts", () => {
    const extracted = extractUserParts([
      {
        info: { id: "msg-u1", role: "user", sessionID: "s1", agent: "hephaestus" },
        parts: [{ id: "p1", type: "text", text: "original task" }],
      },
      {
        info: { id: "msg-a1", role: "assistant", sessionID: "s1", agent: "hephaestus" },
        parts: [{ id: "p2", type: "text", text: "working" }],
      },
      {
        info: { id: "msg-u2", role: "user", sessionID: "s1", agent: "hephaestus" },
        parts: [{ id: "p3", type: "step-start" }],
      },
    ])

    expect(extracted).toEqual({
      info: { id: "msg-u1", role: "user", sessionID: "s1", agent: "hephaestus" },
      parts: [{ type: "text", text: "original task" }],
    })
  })

  it("still skips synthetic parts unless explicitly allowed", () => {
    const messages = [{
      info: { id: "msg-u1", role: "user" as const, sessionID: "s1", agent: "hephaestus" },
      parts: [{ id: "p1", type: "text", text: "synthetic task", synthetic: true }],
    }]

    expect(extractUserParts(messages)).toBeNull()
    expect(extractUserParts(messages, { allowSynthetic: true })).toEqual({
      info: { id: "msg-u1", role: "user", sessionID: "s1", agent: "hephaestus" },
      parts: [{ type: "text", text: "synthetic task" }],
    })
  })
})

describe("shouldWriteLog", () => {
  it("filters high-volume event received logs", () => {
    expect(shouldWriteLog("event received", { type: "message.part.delta" })).toBe(false)
    expect(shouldWriteLog("event received", { type: "session.idle" })).toBe(false)
  })

  it("keeps meaningful event received logs", () => {
    expect(shouldWriteLog("event received", { type: "session.error" })).toBe(true)
    expect(shouldWriteLog("event received", { type: "session.deleted" })).toBe(true)
  })

  it("keeps non-generic log messages", () => {
    expect(shouldWriteLog("Retryable error", { type: "message.part.delta" })).toBe(true)
  })
})

describe("session state - backoff", () => {
  const sid = "test-backoff"
  afterEach(() => removeSession(sid))
  it("starts at 0", () => expect(getBackoffLevel(sid)).toBe(0))
  it("increments", () => {
    expect(incrementBackoff(sid)).toBe(1)
    expect(incrementBackoff(sid)).toBe(2)
  })
  it("resets", () => {
    incrementBackoff(sid); incrementBackoff(sid)
    resetBackoff(sid)
    expect(getBackoffLevel(sid)).toBe(0)
  })
  it("resetIfExpired clears backoff", () => {
    incrementBackoff(sid); incrementBackoff(sid)
    activateCooldown(sid, -1)
    resetIfExpired(sid)
    expect(getBackoffLevel(sid)).toBe(0)
  })
})

describe("isTransientErrorMessage", () => {
  it("matches transient rate-limit messages", () => {
    expect(isTransientErrorMessage("rate limit exceeded")).toBe(true)
    expect(isTransientErrorMessage("too many requests")).toBe(true)
    expect(isTransientErrorMessage("service overloaded, try again")).toBe(true)
    expect(isTransientErrorMessage("capacity exceeded")).toBe(true)
  })

  it("matches network error messages", () => {
    expect(isTransientErrorMessage("fetch failed: ECONNREFUSED")).toBe(true)
    expect(isTransientErrorMessage("ECONNRESET")).toBe(true)
    expect(isTransientErrorMessage("socket hang up")).toBe(true)
    expect(isTransientErrorMessage("TypeError: fetch failed")).toBe(true)
    expect(isTransientErrorMessage("network error")).toBe(true)
    expect(isTransientErrorMessage("connection refused")).toBe(true)
    expect(isTransientErrorMessage("ETIMEDOUT")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isTransientErrorMessage("RATE LIMIT EXCEEDED")).toBe(true)
    expect(isTransientErrorMessage("Too Many Requests")).toBe(true)
    expect(isTransientErrorMessage("ECONNREFUSED")).toBe(true)
  })

  it("does not match permanent or unrelated messages", () => {
    expect(isTransientErrorMessage("The usage limit has been reached")).toBe(false)
    expect(isTransientErrorMessage("Your credit balance is too low")).toBe(false)
    expect(isTransientErrorMessage("invalid API key")).toBe(false)
    expect(isTransientErrorMessage("model not found")).toBe(false)
  })
})

describe("isPermanentRateLimitMessage", () => {
  it("matches permanent rate-limit messages", () => {
    expect(isPermanentRateLimitMessage("The usage limit has been reached")).toBe(true)
    expect(isPermanentRateLimitMessage("quota exceeded for this plan")).toBe(true)
    expect(isPermanentRateLimitMessage("Your credit balance is too low")).toBe(true)
    expect(isPermanentRateLimitMessage("billing issue detected")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isPermanentRateLimitMessage("Usage Limit has been Reached")).toBe(true)
    expect(isPermanentRateLimitMessage("CREDIT BALANCE")).toBe(true)
  })

  it("does not match transient or unrelated messages", () => {
    expect(isPermanentRateLimitMessage("rate limit exceeded")).toBe(false)
    expect(isPermanentRateLimitMessage("too many requests")).toBe(false)
    expect(isPermanentRateLimitMessage("invalid API key")).toBe(false)
    expect(isPermanentRateLimitMessage("connection timeout")).toBe(false)
  })
})

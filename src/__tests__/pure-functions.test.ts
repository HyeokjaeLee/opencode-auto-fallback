import { describe, it, expect, afterEach } from "vitest"
import { parseModel, getFallbackChain } from "../config"
import { isImmediateFallback } from "../matcher"
import { classifyError } from "../decision"
import {
  isCooldownActive,
  activateCooldown,
  incrementBackoff,
  getBackoffLevel,
  resetBackoff,
  resetIfExpired,
  removeSession,
} from "../session-state"
import {
  markProviderBroken,
  isProviderBroken,
  clearBrokenProviders,
  clearBrokenProvider,
} from "../provider-state"
import type { FallbackConfig } from "../types"

describe("parseModel", () => {
  it("parses 'provider/model'", () => {
    expect(parseModel("anthropic/claude-sonnet-4")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
  })
  it("no slash → providerID = modelID", () => {
    expect(parseModel("mymodel")).toEqual({ providerID: "mymodel", modelID: "mymodel" })
  })
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
    rateLimitRetries: 3,
    logging: false,
  }
  it("agent-specific", () => expect(getFallbackChain(config, "build")).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4" }]))
  it("preserves variant", () => expect(getFallbackChain(config, "oracle")).toEqual([
    { providerID: "openai", modelID: "gpt-5.5" },
    { providerID: "zai-coding-plan", modelID: "glm-5.1", variant: "high" },
  ]))
  it("falls back to default", () => expect(getFallbackChain(config, "unknown")).toEqual([{ providerID: "anthropic", modelID: "claude-opus-4-5" }]))
})

describe("isImmediateFallback", () => {
  it("exceeded your", () => expect(isImmediateFallback("You exceeded your current quota")).toBe(true))
  it("quota exceeded", () => expect(isImmediateFallback("Error: quota exceeded")).toBe(true))
  it("exhausted", () => expect(isImmediateFallback("credits exhausted")).toBe(true))
  it("authentication", () => expect(isImmediateFallback("Authentication failed")).toBe(true))
  it("unauthorized", () => expect(isImmediateFallback("401 Unauthorized")).toBe(true))
  it("invalid api key", () => expect(isImmediateFallback("Invalid API key provided")).toBe(true))
  it("model not found", () => expect(isImmediateFallback("model not found in this region")).toBe(true))
  it("not immediate (rate limit)", () => expect(isImmediateFallback("rate limit reached")).toBe(false))
  it("not immediate (unknown)", () => expect(isImmediateFallback("internal server error")).toBe(false))
})

describe("classifyError", () => {
  it("immediate → immediate", () => expect(classifyError("quota exceeded", false)).toEqual({ action: "immediate" }))
  it("unknown → retry (default)", () => expect(classifyError("internal error", false)).toEqual({ action: "retry" }))
  it("rate limit → retry", () => expect(classifyError("rate limit reached", false)).toEqual({ action: "retry" }))
  it("timeout → retry", () => expect(classifyError("request timed out", false)).toEqual({ action: "retry" }))
  it("cooldown → ignore", () => expect(classifyError("anything", true)).toEqual({ action: "ignore" }))
})

describe("provider-state", () => {
  afterEach(() => clearBrokenProviders())

  it("starts empty", () => {
    expect(isProviderBroken("openai")).toBe(false)
    expect(isProviderBroken("zai-coding-plan")).toBe(false)
  })
  it("marks and checks", () => {
    markProviderBroken("openai")
    expect(isProviderBroken("openai")).toBe(true)
    expect(isProviderBroken("zai-coding-plan")).toBe(false)
  })
  it("clears individual", () => {
    markProviderBroken("openai")
    markProviderBroken("zai-coding-plan")
    clearBrokenProvider("openai")
    expect(isProviderBroken("openai")).toBe(false)
    expect(isProviderBroken("zai-coding-plan")).toBe(true)
  })
  it("clears all", () => {
    markProviderBroken("openai")
    markProviderBroken("zai-coding-plan")
    clearBrokenProviders()
    expect(isProviderBroken("openai")).toBe(false)
    expect(isProviderBroken("zai-coding-plan")).toBe(false)
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

import { describe, it, expect, afterEach } from "vitest"
import { parseModel, getFallbackChain } from "../config"
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
import { markModelCooldown, isModelInCooldown, clearAllCooldowns } from "../provider-state"
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
})

describe("classifyError", () => {
  it("immediate via pattern", () => {
    expect(classifyError("quota exceeded", false)).toEqual(expect.objectContaining({ action: "immediate" }))
  })
  it("retry via pattern", () => {
    expect(classifyError("rate limit reached", false)).toEqual(expect.objectContaining({ action: "retry" }))
  })
  it("retry as default", () => {
    expect(classifyError("something broke", false)).toEqual({ action: "retry" })
  })
  it("ignore when cooldown active", () => {
    expect(classifyError("quota exceeded", true)).toEqual({ action: "ignore" })
  })
  it("HTTP 429 → retry", () => {
    expect(classifyError("429 Too Many Requests", false)).toEqual(expect.objectContaining({ action: "retry", httpStatus: 429 }))
  })
  it("HTTP 401 → immediate", () => {
    expect(classifyError("HTTP 401 Unauthorized", false)).toEqual(expect.objectContaining({ action: "immediate", httpStatus: 401 }))
  })
})

describe("provider-state (timed cooldown)", () => {
  afterEach(() => clearAllCooldowns())

  it("starts as not in cooldown", () => {
    expect(isModelInCooldown("openai", "gpt-5.5")).toBe(false)
  })
  it("marks and checks cooldown", () => {
    markModelCooldown("openai", "gpt-5.5", 60_000)
    expect(isModelInCooldown("openai", "gpt-5.5")).toBe(true)
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(false)
  })
  it("auto-expires", () => {
    markModelCooldown("openai", "gpt-5.5", -1)
    expect(isModelInCooldown("openai", "gpt-5.5")).toBe(false)
  })
  it("clearAllCooldowns resets", () => {
    markModelCooldown("openai", "gpt-5.5", 60_000)
    clearAllCooldowns()
    expect(isModelInCooldown("openai", "gpt-5.5")).toBe(false)
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

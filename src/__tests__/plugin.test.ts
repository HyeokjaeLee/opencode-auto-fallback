import { describe, it, expect, vi, afterEach } from "vitest"
import type { FallbackConfig } from "../types"
import { _forTesting } from "../plugin"
import { clearAllCooldowns, isModelInCooldown } from "../provider-state"
import { removeSession } from "../session-state"
import { createMockContext, createMockMessages } from "./mocks"

const { handleRetry, handleImmediate, tryFallbackChain, showToastSafely, revertAndPrompt, isLargeContextAgent } = _forTesting

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    enabled: true,
    defaultFallback: ["openai/gpt-5.4"],
    agentFallbacks: {},
    cooldownMs: 60_000,
    maxRetries: 2,
    logging: false,
    ...overrides,
  }
}

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const SESSION = "test-session-1"

afterEach(() => {
  removeSession(SESSION)
  clearAllCooldowns()
  vi.clearAllMocks()
})

describe("showToastSafely", () => {
  it("calls tui.showToast and returns", async () => {
    const mockToast = vi.fn().mockResolvedValue(true)
    const ctx = createMockContext({ showToast: mockToast })

    await showToastSafely(ctx, { message: "test", variant: "info" }, noopLogger)

    expect(mockToast).toHaveBeenCalledWith({
      body: { message: "test", variant: "info" },
    })
  })

  it("swallows toast errors gracefully", async () => {
    const mockToast = vi.fn().mockRejectedValue(new Error("tui not available"))
    const ctx = createMockContext({ showToast: mockToast })

    await expect(
      showToastSafely(ctx, { message: "test", variant: "warning" }, noopLogger),
    ).resolves.toBeUndefined()

    expect(noopLogger.warn).toHaveBeenCalled()
  })
})

describe("isLargeContextAgent", () => {
  it("matches configured agents case-insensitively and ignores whitespace", () => {
    expect(isLargeContextAgent("Sisyphus", ["sisyphus", "hephaestus"])).toBe(true)
    expect(isLargeContextAgent("HEPHAESTUS", ["sisyphus", "hephaestus"])).toBe(true)
    expect(isLargeContextAgent("​Sisyphus - Ultraworker", ["sisyphus-ultraworker"])).toBe(true)
  })

  it("does not match different agent names", () => {
    expect(isLargeContextAgent("Sisyphus - Ultraworker", ["sisyphus", "hephaestus"])).toBe(false)
    expect(isLargeContextAgent(undefined, ["sisyphus", "hephaestus"])).toBe(false)
  })
})

describe("tryFallbackChain", () => {
  it("tries models in order until success", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert })

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ]

    const ok = await tryFallbackChain(
      SESSION, chain, "oracle", [{ type: "text", text: "hi" }], "msg-u1", noopLogger, ctx,
    )

    expect(ok).toBe(true)
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    )
  })

  it("continues to next model on failure", async () => {
    let callCount = 0
    const mockPrompt = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 2) return Promise.resolve(undefined)
      return Promise.reject(new Error("connection failed"))
    })
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert })

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ]

    const ok = await tryFallbackChain(
      SESSION, chain, "oracle", [{ type: "text", text: "hi" }], "msg-u1", noopLogger, ctx,
    )

    expect(ok).toBe(true)
    expect(mockPrompt).toHaveBeenCalledTimes(2)
  })

  it("returns false when all models exhausted", async () => {
    const mockPrompt = vi.fn().mockRejectedValue(new Error("all failed"))
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert })

    const ok = await tryFallbackChain(
      SESSION, [{ providerID: "openai", modelID: "gpt-5.4" }],
      "oracle", [{ type: "text", text: "hi" }], "msg-u1", noopLogger, ctx,
    )

    expect(ok).toBe(false)
    expect(noopLogger.error).toHaveBeenCalledWith(
      "All fallback models exhausted",
      expect.any(Object),
    )
  })
})

describe("handleImmediate", () => {
  it("aborts, marks cooldown, and tries fallback chain", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined)
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    })
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    })
    const config = makeConfig()

    await handleImmediate(SESSION, config, noopLogger, ctx)

    expect(mockAbort).toHaveBeenCalled()
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    )
  })

  it("marks model cooldown from hook input when messages have no assistant", async () => {
    const mockMessages = vi.fn().mockResolvedValue({ data: [] })
    const ctx = createMockContext({ messages: mockMessages })
    const config = makeConfig()

    await handleImmediate(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })

    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true)
  })

  it("logs error but still marks cooldown when no user message and hook input provided", async () => {
    const mockMessages = vi.fn().mockResolvedValue({ data: [] })
    const ctx = createMockContext({ messages: mockMessages })
    const config = makeConfig()

    await handleImmediate(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })

    expect(noopLogger.error).toHaveBeenCalledWith(
      "Cannot fallback: no valid user message",
      expect.any(Object),
    )
    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true)
  })
})

describe("handleRetry", () => {
  it("retries same model within maxRetries", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined)
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    })
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    })
    const config = makeConfig({ maxRetries: 2 })

    await handleRetry(SESSION, config, noopLogger, ctx)

    expect(mockAbort).toHaveBeenCalled()
    // Should re-prompt with the SAME model (gpt-5.5), not the fallback (gpt-5.4)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.5" },
        }),
      }),
    )
  })

  it("switches to fallback chain after maxRetries exhausted", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined)
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    })
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    })
    const config = makeConfig({ maxRetries: 0 })

    await handleRetry(SESSION, config, noopLogger, ctx)

    // Should use the FALLBACK model (gpt-5.4), not the original (gpt-5.5)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    )
  })

  it("does nothing when messages are missing", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [] }),
    })

    await handleRetry(SESSION, makeConfig(), noopLogger, ctx)

    expect(noopLogger.error).toHaveBeenCalledWith(
      "Cannot retry: missing user message",
      expect.any(Object),
    )
  })

  it("prefers model from assistant message over hook input", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined)
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    })
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    })
    const config = makeConfig()

    await handleRetry(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-opus-4" },
    })

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.5" },
        }),
      }),
    )
  })
})

describe("revertAndPrompt", () => {
  it("reverts then prompts with model", async () => {
    const mockRevert = vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({ revert: mockRevert, prompt: mockPrompt })

    const ok = await revertAndPrompt(
      SESSION, "oracle", [{ type: "text", text: "hi" }], "msg-u1",
      { providerID: "openai", modelID: "gpt-5.4" },
      noopLogger, ctx,
    )

    expect(ok).toBe(true)
    expect(mockRevert).toHaveBeenCalledWith({
      path: { id: SESSION },
      body: { messageID: "msg-u1" },
    })
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
          agent: "oracle",
        }),
      }),
    )
  })

  it("passes variant when specified", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({ prompt: mockPrompt })

    await revertAndPrompt(
      SESSION, "oracle", [{ type: "text", text: "hi" }], "msg-u1",
      { providerID: "openai", modelID: "gpt-5.4", variant: "high" },
      noopLogger, ctx,
    )

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          variant: "high",
        }),
      }),
    )
  })
})

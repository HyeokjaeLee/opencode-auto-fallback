import { describe, it, expect, vi, afterEach } from "vitest";
import type { FallbackConfig } from "../types";
import { handleRetry, handleImmediate, tryFallbackChain } from "../fallback";
import { showToastSafely } from "../session-utils";
import { shouldSkipLargeContextFallback } from "../large-context";
import { revertAndPrompt } from "../fallback";
import { isRegisteredAgent, setRegisteredAgents } from "../state/context-state";
import { isModelInCooldown } from "../provider-state";
import { removeSession } from "../session-state";
import { createMockContext, createMockMessages } from "./mocks";

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    enabled: true,
    defaultFallback: ["openai/gpt-5.4"],
    agentFallbacks: {},
    cooldownMs: 60_000,
    maxRetries: 2,
    logging: false,
    ...overrides,
  };
}

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const SESSION = "test-session-1";

afterEach(() => {
  removeSession(SESSION);
  vi.clearAllMocks();
});

describe("showToastSafely", () => {
  it("calls tui.showToast and returns", async () => {
    const mockToast = vi.fn().mockResolvedValue(true);
    const ctx = createMockContext({ showToast: mockToast });

    await showToastSafely(ctx, { message: "test", variant: "info" }, noopLogger);

    expect(mockToast).toHaveBeenCalledWith({
      body: { message: "test", variant: "info" },
    });
  });

  it("swallows toast errors gracefully", async () => {
    const mockToast = vi.fn().mockRejectedValue(new Error("tui not available"));
    const ctx = createMockContext({ showToast: mockToast });

    await expect(
      showToastSafely(ctx, { message: "test", variant: "warning" }, noopLogger),
    ).resolves.toBeUndefined();

    expect(noopLogger.warn).toHaveBeenCalled();
  });
});

describe("isRegisteredAgent", () => {
  afterEach(() => {
    setRegisteredAgents([]);
  });

  it("matches agents that were registered via setRegisteredAgents", () => {
    setRegisteredAgents(["sisyphus", "hephaestus"]);
    expect(isRegisteredAgent("sisyphus")).toBe(true);
    expect(isRegisteredAgent("hephaestus")).toBe(true);
  });

  it("does not match unregistered agents", () => {
    setRegisteredAgents(["sisyphus"]);
    expect(isRegisteredAgent("hephaestus")).toBe(false);
  });

  it("returns false when no agents are registered", () => {
    expect(isRegisteredAgent("sisyphus")).toBe(false);
  });

  it("normalizes agent name at lookup time", () => {
    setRegisteredAgents(["sisyphus-ultraworker"]);
    expect(isRegisteredAgent("Sisyphus - Ultraworker")).toBe(true);
    expect(isRegisteredAgent("SISYPHUS-ULTRAWORKER")).toBe(true);
    expect(isRegisteredAgent("hephaestus")).toBe(false);
  });
});

describe("tryFallbackChain", () => {
  it("tries models in order until success", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert });

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ];

    const ok = await tryFallbackChain(
      SESSION,
      chain,
      "oracle",
      [{ type: "text", text: "hi" }],
      "msg-u1",
      noopLogger,
      ctx,
    );

    expect(ok).toBe(true);
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    );
  });

  it("continues to next model on failure", async () => {
    let callCount = 0;
    const mockPrompt = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.resolve(undefined);
      return Promise.reject(new Error("connection failed"));
    });
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert });

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ];

    const ok = await tryFallbackChain(
      SESSION,
      chain,
      "oracle",
      [{ type: "text", text: "hi" }],
      "msg-u1",
      noopLogger,
      ctx,
    );

    expect(ok).toBe(true);
    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it("returns false when all models exhausted", async () => {
    const mockPrompt = vi.fn().mockRejectedValue(new Error("all failed"));
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const ctx = createMockContext({ prompt: mockPrompt, revert: mockRevert });

    const ok = await tryFallbackChain(
      SESSION,
      [{ providerID: "openai", modelID: "gpt-5.4" }],
      "oracle",
      [{ type: "text", text: "hi" }],
      "msg-u1",
      noopLogger,
      ctx,
    );

    expect(ok).toBe(false);
    expect(noopLogger.error).toHaveBeenCalledWith(
      "All fallback models exhausted",
      expect.any(Object),
    );
  });
});

describe("handleImmediate", () => {
  it("aborts, marks cooldown, and tries fallback chain", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    });
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    });
    const config = makeConfig();

    await handleImmediate(SESSION, config, noopLogger, ctx);

    expect(mockAbort).toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    );
  });

  it("marks model cooldown from hook input when messages have no assistant", async () => {
    const mockMessages = vi.fn().mockResolvedValue({ data: [] });
    const ctx = createMockContext({ messages: mockMessages });
    const config = makeConfig();

    await handleImmediate(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });

    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true);
  });

  it("logs error but still marks cooldown when no user message and hook input provided", async () => {
    const mockMessages = vi.fn().mockResolvedValue({ data: [] });
    const ctx = createMockContext({ messages: mockMessages });
    const config = makeConfig();

    await handleImmediate(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    });

    expect(noopLogger.error).toHaveBeenCalledWith(
      "Cannot fallback: no valid user message",
      expect.any(Object),
    );
    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true);
  });
});

describe("handleRetry", () => {
  it("retries same model within maxRetries", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    });
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    });
    const config = makeConfig({ maxRetries: 2 });

    await handleRetry(SESSION, config, noopLogger, ctx);

    expect(mockAbort).toHaveBeenCalled();
    // Should re-prompt with the SAME model (gpt-5.5), not the fallback (gpt-5.4)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.5" },
        }),
      }),
    );
  });

  it("switches to fallback chain after maxRetries exhausted", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    });
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    });
    const config = makeConfig({ maxRetries: 0 });

    await handleRetry(SESSION, config, noopLogger, ctx);

    // Should use the FALLBACK model (gpt-5.4), not the original (gpt-5.5)
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    );
  });

  it("does nothing when messages are missing", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });

    await handleRetry(SESSION, makeConfig(), noopLogger, ctx);

    expect(noopLogger.error).toHaveBeenCalledWith(
      "Cannot retry: missing user message",
      expect.any(Object),
    );
  });

  it("prefers model from assistant message over hook input", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockMessages = vi.fn().mockResolvedValue({
      data: createMockMessages({
        providerID: "openai",
        modelID: "gpt-5.5",
        agent: "oracle",
      }),
    });
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      messages: mockMessages,
      revert: mockRevert,
      prompt: mockPrompt,
    });
    const config = makeConfig();

    await handleRetry(SESSION, config, noopLogger, ctx, {
      sessionID: SESSION,
      agent: "oracle",
      model: { providerID: "anthropic", modelID: "claude-opus-4" },
    });

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.5" },
        }),
      }),
    );
  });
});

describe("revertAndPrompt", () => {
  it("reverts then prompts with model", async () => {
    const mockRevert = vi
      .fn()
      .mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ revert: mockRevert, prompt: mockPrompt });

    const ok = await revertAndPrompt(
      SESSION,
      "oracle",
      [{ type: "text", text: "hi" }],
      "msg-u1",
      { providerID: "openai", modelID: "gpt-5.4" },
      noopLogger,
      ctx,
    );

    expect(ok).toBe(true);
    expect(mockRevert).toHaveBeenCalledWith({
      path: { id: SESSION },
      body: { messageID: "msg-u1" },
    });
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
          agent: "oracle",
        }),
      }),
    );
  });

  it("passes variant when specified", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt: mockPrompt });

    await revertAndPrompt(
      SESSION,
      "oracle",
      [{ type: "text", text: "hi" }],
      "msg-u1",
      { providerID: "openai", modelID: "gpt-5.4", variant: "high" },
      noopLogger,
      ctx,
    );

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          variant: "high",
        }),
      }),
    );
  });
});

describe("shouldSkipLargeContextFallback", () => {
  it("returns false when ratio exceeds 1 + minContextRatio (large enough difference)", () => {
    expect(shouldSkipLargeContextFallback(100, 210, 0.1)).toBe(false);
  });

  it("returns true when ratio is below 1 + minContextRatio (difference < 10%)", () => {
    expect(shouldSkipLargeContextFallback(1000, 1050, 0.1)).toBe(true);
  });

  it("returns true when ratio equals exactly 1 + minContextRatio (difference == 10%)", () => {
    expect(shouldSkipLargeContextFallback(10000, 11000, 0.1)).toBe(true);
  });

  it("returns true for identical context windows (0% difference)", () => {
    expect(shouldSkipLargeContextFallback(128000, 128000, 0.1)).toBe(true);
  });

  it("respects custom minContextRatio", () => {
    // 100% difference (ratio = 2), but require 200% (minContextRatio = 2)
    expect(shouldSkipLargeContextFallback(100, 200, 2)).toBe(true);
  });
});

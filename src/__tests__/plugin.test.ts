import { afterEach, describe, expect, it, vi } from "vitest";

import type { FallbackConfig } from "@/config/types";
import { fallbackToModel, handleImmediate, handleRetry, tryFallbackChain } from "@/core/fallback";
import { shouldSkipLargeContextFallback } from "@/core/large-context";
import {
  cleanupSession,
  isRegisteredAgent,
  setCurrentModel,
  setRegisteredAgents,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { removeSession } from "@/state/session-state";
import { showToastSafely } from "@/utils/session-utils";

import { createMockContext } from "./mocks";

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    enabled: true,
    autoUpdate: true,
    defaultFallback: ["openai/gpt-5.4"],
    defaultLargeContextModel: false,
    defaultMinContextRatio: 0.1,
    agents: {},
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
  cleanupSession(SESSION);
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
    const ctx = createMockContext({ prompt: mockPrompt });

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ];

    const ok = await tryFallbackChain(
      SESSION,
      chain,
      "oracle",
      { providerID: "original", modelID: "model-a" },
      "Test fallback",
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
    const ctx = createMockContext({ prompt: mockPrompt });

    const chain = [
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "zai-coding-plan", modelID: "glm-5.1" },
    ];

    const ok = await tryFallbackChain(
      SESSION,
      chain,
      "oracle",
      { providerID: "original", modelID: "model-a" },
      "Test fallback",
      noopLogger,
      ctx,
    );

    expect(ok).toBe(true);
    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it("returns false when all models exhausted", async () => {
    const mockPrompt = vi.fn().mockRejectedValue(new Error("all failed"));
    const ctx = createMockContext({ prompt: mockPrompt });

    const ok = await tryFallbackChain(
      SESSION,
      [{ providerID: "openai", modelID: "gpt-5.4" }],
      "oracle",
      { providerID: "original", modelID: "model-a" },
      "Test fallback",
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
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ abort: mockAbort, prompt: mockPrompt });
    const config = makeConfig();

    setCurrentModel(SESSION, "openai", "gpt-5.5");
    setSessionOriginalAgent(SESSION, "oracle");

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

  it("marks model cooldown from context state", async () => {
    const ctx = createMockContext();
    const config = makeConfig();

    setCurrentModel(SESSION, "anthropic", "claude-sonnet-4");
    setSessionOriginalAgent(SESSION, "oracle");

    await handleImmediate(SESSION, config, noopLogger, ctx);

    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true);
  });

  it("logs warning when no current model and still tries chain", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt: mockPrompt });
    const config = makeConfig();

    setSessionOriginalAgent(SESSION, "oracle");

    await handleImmediate(SESSION, config, noopLogger, ctx);

    expect(noopLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Immediate fallback chain"),
      expect.any(Object),
    );
  });
});

describe("handleRetry", () => {
  it("retries same model within maxRetries", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ abort: mockAbort, prompt: mockPrompt });
    const config = makeConfig({ maxRetries: 2 });

    setCurrentModel(SESSION, "openai", "gpt-5.5");
    setSessionOriginalAgent(SESSION, "oracle");

    await handleRetry(SESSION, config, noopLogger, ctx);

    expect(mockAbort).toHaveBeenCalled();
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
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ abort: mockAbort, prompt: mockPrompt });
    const config = makeConfig({ maxRetries: 0 });

    setCurrentModel(SESSION, "openai", "gpt-5.5");
    setSessionOriginalAgent(SESSION, "oracle");

    await handleRetry(SESSION, config, noopLogger, ctx);

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    );
  });

  it("goes straight to chain when no current model", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt: mockPrompt });
    const config = makeConfig({ maxRetries: 0 });

    setSessionOriginalAgent(SESSION, "oracle");

    await handleRetry(SESSION, config, noopLogger, ctx);

    expect(noopLogger.warn).toHaveBeenCalledWith(
      "No current model available, going straight to fallback chain",
      expect.any(Object),
    );
  });
});

describe("fallbackToModel", () => {
  it("prompts with model and Continue text", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt: mockPrompt });

    const ok = await fallbackToModel(
      SESSION,
      "oracle",
      { providerID: "original", modelID: "model-a" },
      { providerID: "openai", modelID: "gpt-5.4" },
      "Test fallback",
      noopLogger,
      ctx,
    );

    expect(ok).toBe(true);
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.4" },
          agent: "oracle",
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "text", ignored: true }),
            expect.objectContaining({ type: "text", synthetic: true, text: "Continue" }),
          ]),
        }),
      }),
    );
  });

  it("passes variant when specified", async () => {
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt: mockPrompt });

    await fallbackToModel(
      SESSION,
      "oracle",
      { providerID: "original", modelID: "model-a" },
      { providerID: "openai", modelID: "gpt-5.4", variant: "high" },
      "Test fallback",
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
    expect(shouldSkipLargeContextFallback(100, 200, 2)).toBe(true);
  });
});

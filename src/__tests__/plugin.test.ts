import { afterEach, describe, expect, it, vi } from "vitest";

import { SUBAGENT_IDLE_POLL_INTERVAL_MS, SUBAGENT_IDLE_TIMEOUT_MS } from "@/config/constants";
import type { FallbackConfig } from "@/config/types";
import { fallbackToModel, handleImmediate, handleRetry, tryFallbackChain } from "@/core/fallback";
import { shouldSkipLargeContextFallback } from "@/core/large-context";
import { handleSessionError } from "@/hooks/handle-session-error";
import { handleSessionIdle } from "@/hooks/handle-session-idle";
import {
  cleanupSession,
  getMaxSelfCompactionCycles,
  getOrSetOriginalModel,
  getSelfCompactionCount,
  incrementSelfCompactionCount,
  isRegisteredAgent,
  resetSelfCompactionCount,
  setCompactionTarget,
  setCurrentModel,
  setLargeContextPhase,
  setModelContextLimit,
  setRegisteredAgents,
  setRestoreModel,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { isModelInCooldown } from "@/state/provider-state";
import { removeSession } from "@/state/session-state";

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
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockPrompt).toHaveBeenLastCalledWith(
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
    expect(mockPrompt).toHaveBeenCalledTimes(3);
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

  it("continues the fallback chain when the abort call rejects (issue #6)", async () => {
    const mockAbort = vi.fn().mockRejectedValue(new Error("connection refused"));
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ abort: mockAbort, prompt: mockPrompt });
    const config = makeConfig();

    setCurrentModel(SESSION, "openai", "gpt-5.5");
    setSessionOriginalAgent(SESSION, "oracle");

    await handleImmediate(SESSION, config, noopLogger, ctx);

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
          parts: [expect.objectContaining({ type: "text", synthetic: true, text: "Continue" })],
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

describe("self-compaction counter", () => {
  it("increments and retrieves count", () => {
    expect(getSelfCompactionCount("session-1")).toBe(0);
    expect(incrementSelfCompactionCount("session-1")).toBe(1);
    expect(incrementSelfCompactionCount("session-1")).toBe(2);
    expect(getSelfCompactionCount("session-1")).toBe(2);
  });

  it("resets count for session", () => {
    incrementSelfCompactionCount("session-1");
    incrementSelfCompactionCount("session-1");
    resetSelfCompactionCount("session-1");
    expect(getSelfCompactionCount("session-1")).toBe(0);
  });

  it("returns max self-compaction cycles", () => {
    expect(getMaxSelfCompactionCycles()).toBe(2);
  });

  it("tracks count independently per session", () => {
    incrementSelfCompactionCount("session-1");
    incrementSelfCompactionCount("session-2");
    expect(getSelfCompactionCount("session-1")).toBe(1);
    expect(getSelfCompactionCount("session-2")).toBe(1);
  });

  it("is cleaned up by cleanupSession", () => {
    incrementSelfCompactionCount("session-1");
    cleanupSession("session-1");
    expect(getSelfCompactionCount("session-1")).toBe(0);
  });
});

describe("subagent session recovery (issue #4)", () => {
  const CHILD = "child-session-1";

  afterEach(() => {
    cleanupSession(CHILD);
    removeSession(CHILD);
    setRegisteredAgents([]);
  });

  function childContext(overrides?: Parameters<typeof createMockContext>[0]) {
    return createMockContext({
      get: vi.fn().mockResolvedValue({ data: { id: CHILD, parentID: "parent-1" } }),
      ...overrides,
    });
  }

  it("handleImmediate never aborts a child session and re-prompts it", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = childContext({ abort: mockAbort, prompt: mockPrompt });

    setCurrentModel(CHILD, "openai", "gpt-5.5");
    setSessionOriginalAgent(CHILD, "oracle");

    await handleImmediate(CHILD, makeConfig(), noopLogger, ctx);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agent: "oracle",
          model: { providerID: "openai", modelID: "gpt-5.4" },
        }),
      }),
    );
  });

  it("handleImmediate skips the prompt when a child never becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const mockAbort = vi.fn().mockResolvedValue(undefined);
      const mockPrompt = vi.fn().mockResolvedValue(undefined);
      const ctx = childContext({
        abort: mockAbort,
        prompt: mockPrompt,
        status: vi.fn().mockResolvedValue({ data: { [CHILD]: { type: "busy" } } }),
      });

      setCurrentModel(CHILD, "openai", "gpt-5.5");
      setSessionOriginalAgent(CHILD, "oracle");

      const pending = handleImmediate(CHILD, makeConfig(), noopLogger, ctx);
      await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TIMEOUT_MS + SUBAGENT_IDLE_POLL_INTERVAL_MS);
      await pending;

      expect(mockAbort).not.toHaveBeenCalled();
      expect(mockPrompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handleRetry never aborts a child session and re-prompts it", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = childContext({ abort: mockAbort, prompt: mockPrompt });

    setCurrentModel(CHILD, "openai", "gpt-5.5");
    setSessionOriginalAgent(CHILD, "oracle");

    await handleRetry(CHILD, makeConfig(), noopLogger, ctx);

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ agent: "oracle" }),
      }),
    );
  });

  it("context-overflow recovery never aborts a child session (issue #4)", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = childContext({
      abort: mockAbort,
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: { id: "u1", role: "user", sessionID: CHILD, agent: "big" },
            parts: [{ type: "text", text: "task" }],
          },
          {
            info: {
              role: "assistant",
              tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [],
          },
        ],
      }),
    });

    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(CHILD, "big");
    setCurrentModel(CHILD, "anthropic", "claude-sonnet-4");
    getOrSetOriginalModel(CHILD, "anthropic", "claude-sonnet-4");

    await handleSessionError(
      makeConfig({ agents: { big: { largeContextModel: "google/gemini-2.5-pro" } } }),
      noopLogger,
      ctx,
      {
        type: "session.error",
        properties: {
          sessionID: CHILD,
          error: { name: "Error", data: { message: "context length exceeded" } },
        },
      },
    );

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-2.5-pro" },
          agent: "big",
        }),
      }),
    );
  });

  it("active-phase child overflow never aborts a child session (issue #4)", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = childContext({ abort: mockAbort, summarize: mockSummarize });

    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(CHILD, "big");
    setCurrentModel(CHILD, "anthropic", "claude-sonnet-4");
    getOrSetOriginalModel(CHILD, "anthropic", "claude-sonnet-4");
    setRestoreModel(CHILD, "anthropic", "claude-sonnet-4");
    setLargeContextPhase(CHILD, "active");
    setCompactionTarget(CHILD, "default");

    await handleSessionError(
      makeConfig({ agents: { big: { largeContextModel: "google/gemini-2.5-pro" } } }),
      noopLogger,
      ctx,
      {
        type: "session.error",
        properties: {
          sessionID: CHILD,
          error: { name: "Error", data: { message: "context length exceeded" } },
        },
      },
    );

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { providerID: "google", modelID: "gemini-2.5-pro" },
      }),
    );
  });

  it("idle self-compaction never aborts a child session (issue #4)", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = childContext({
      abort: mockAbort,
      summarize: mockSummarize,
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              role: "assistant",
              tokens: { input: 199600, output: 50, reasoning: 50, cache: { read: 0, write: 0 } },
            },
            parts: [],
          },
        ],
      }),
    });

    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(CHILD, "big");
    setLargeContextPhase(CHILD, "active");
    setCurrentModel(CHILD, "google", "gemini-2.5-pro");
    setModelContextLimit("google/gemini-2.5-pro", 200000);

    await handleSessionIdle(
      makeConfig({ agents: { big: { largeContextModel: "google/gemini-2.5-pro" } } }),
      noopLogger,
      ctx,
      { type: "session.idle", properties: { sessionID: CHILD } },
    );

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockSummarize).toHaveBeenCalled();
  });

  it("compaction-summary retry never aborts a child session (issue #4)", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = childContext({ abort: mockAbort, summarize: mockSummarize });

    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(CHILD, "big");
    setLargeContextPhase(CHILD, "summarizing");

    await handleSessionError(
      makeConfig({ agents: { big: { largeContextModel: "google/gemini-2.5-pro" } } }),
      noopLogger,
      ctx,
      {
        type: "session.error",
        properties: {
          sessionID: CHILD,
          error: {
            name: "Error",
            data: { message: "Tool call not allowed while generating summary" },
          },
        },
      },
    );

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockSummarize).toHaveBeenCalled();
  });
});

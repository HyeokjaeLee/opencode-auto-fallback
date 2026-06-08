import { afterEach, describe, expect, it, vi } from "vitest";

import type { FallbackConfig } from "@/config/types";
import { handleLargeContextCompletion } from "@/core/large-context";
import { handleSessionError } from "@/hooks/handle-session-error";
import { handleSessionIdle } from "@/hooks/handle-session-idle";
import {
  cleanupSession,
  clearSelfCompactionInFlight,
  getLargeContextPhase,
  getOrSetOriginalModel,
  getRecoveryModel,
  getSelfCompactionCount,
  incrementSelfCompactionCount,
  isOpencodeCompacting,
  isReturnDeferred,
  isSelfCompactionInFlight,
  setCurrentModel,
  setCompactionTarget,
  setLargeContextPhase,
  setModelContextLimit,
  setOpencodeCompacting,
  setRegisteredAgents,
  setRestoreModel,
  setSelfCompactionInFlight,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { checkContextThreshold } from "@/utils/context";

import { createMockContext } from "./mocks";

const SID = "test-context-threshold";

function makeAssistantMessage(tokens: {
  input: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}) {
  return {
    info: {
      role: "assistant",
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
      },
    },
  };
}

const noopLogger = {
  info: () => Promise.resolve(),
  warn: () => Promise.resolve(),
  error: () => Promise.resolve(),
};

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    enabled: true,
    autoUpdate: false,
    defaultFallback: [],
    defaultLargeContextModel: false,
    defaultMinContextRatio: 0.1,
    agents: {},
    cooldownMs: 60000,
    maxRetries: 2,
    logging: false,
    ...overrides,
  };
}

describe("checkContextThreshold", () => {
  afterEach(() => {
    cleanupSession(SID);
  });

  it("returns false when no assistant messages with token data", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    expect(result).toEqual({ atThreshold: false, usage: 0, limit: 0 });
  });

  it("returns false when no current model is set", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 100, output: 50 })],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    expect(result).toEqual({ atThreshold: false, usage: 0, limit: 0 });
  });

  it("returns false when no context limit is configured", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 100, output: 50 })],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    expect(result).toEqual({ atThreshold: false, usage: 0, limit: 0 });
  });

  it("includes reasoning tokens in count", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({
            input: 199600,
            output: 50,
            reasoning: 50,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    // count = 199600 + 50 + 50 + 0 + 0 = 199700
    // threshold = 200000 * 0.95 = 190000
    // 199700 >= 190000 → true
    expect(result.atThreshold).toBe(true);
    expect(result.usage).toBe(199700);
    expect(result.limit).toBe(200000);
  });

  it("triggers at exactly 95% of context limit", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    // 95% of 200000 = 190000
    // input=189800, output=100, reasoning=100, cacheRead=0 → count=190000
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({
            input: 189800,
            output: 100,
            reasoning: 100,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    expect(result.atThreshold).toBe(true);
  });

  it("does not trigger below 95% of context limit", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    // 94.99% of 200000 = 189980
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({
            input: 189800,
            output: 90,
            reasoning: 90,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    // count = 189800 + 90 + 90 = 189980
    // threshold = 200000 * 0.95 = 190000
    // 189980 < 190000 → false
    expect(result.atThreshold).toBe(false);
  });

  it("reproduces bug report: 199723 count now triggers with reasoning + ratio fix", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    // Exact scenario from bug report:
    // lastInput=57, lastOutput=50, lastReasoning=31, lastCacheRead=199616
    // OLD: count = 57 + 50 + 199616 = 199723, threshold = 200000 → false (BUG!)
    // NEW: count = 57 + 50 + 31 + 199616 = 199754, threshold = 190000 → true (FIXED!)
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({
            input: 57,
            output: 50,
            reasoning: 31,
            cacheRead: 199616,
            cacheWrite: 0,
          }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    expect(result.atThreshold).toBe(true);
    expect(result.usage).toBe(199754);
  });

  it("does not trigger when context is well below threshold", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({
            input: 180000,
            output: 100,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    // count = 180100, threshold = 200000 * 0.95 = 190000
    // 180100 < 190000 → false
    expect(result.atThreshold).toBe(false);
  });

  it("uses the last assistant message with tokens", async () => {
    setCurrentModel(SID, "zai-coding-plan", "glm-5.1");
    setModelContextLimit("zai-coding-plan/glm-5.1", 200000);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [
          makeAssistantMessage({ input: 5000, output: 100, reasoning: 0 }),
          makeAssistantMessage({ input: 185000, output: 200, reasoning: 4800 }),
        ],
      }),
    });

    const result = await checkContextThreshold(SID, ctx, noopLogger);
    // Last msg: count = 185000 + 200 + 4800 = 190000
    // threshold = 200000 * 0.95 = 190000
    // 190000 >= 190000 → true
    expect(result.atThreshold).toBe(true);
  });
});

describe("handleLargeContextCompletion", () => {
  const CID = "test-completion";

  afterEach(() => {
    cleanupSession(CID);
  });

  it("switches back to original model when context fits", async () => {
    setCurrentModel(CID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(CID, "anthropic", "claude-sonnet-4");
    setRestoreModel(CID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 10000, output: 5000 })],
      }),
    });

    await handleLargeContextCompletion(CID, makeConfig(), ctx, noopLogger);

    // Should switch back — prompt called with original model
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: CID },
        body: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        }),
      }),
    );
  });

  it("stays on large model when context does not fit on original", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(CID, "test-agent");
    setCurrentModel(CID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(CID, "anthropic", "claude-sonnet-4");
    setRestoreModel(CID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 20000);

    const config = makeConfig({
      agents: {
        "test-agent": { largeContextModel: "google/gemini-2.5-pro" },
      },
    });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 50000, output: 10000 })],
      }),
    });

    await handleLargeContextCompletion(CID, config, ctx, noopLogger);

    // Should NOT switch back — prompt called with configured large model
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: CID },
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-2.5-pro" },
        }),
      }),
    );
  });

  it("clears phase and restore model regardless of fit", async () => {
    setCurrentModel(CID, "google", "gemini-2.5-pro");
    setRestoreModel(CID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 10000, output: 5000 })],
      }),
    });

    setLargeContextPhase(CID, "summarizing");
    await handleLargeContextCompletion(CID, makeConfig(), ctx, noopLogger);

    expect(getLargeContextPhase(CID)).toBeUndefined();
    expect(getRecoveryModel(CID)).toBeUndefined();
  });

  it("resets self-compaction count on completion", async () => {
    setCurrentModel(CID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(CID, "anthropic", "claude-sonnet-4");
    setRestoreModel(CID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);

    incrementSelfCompactionCount(CID);
    incrementSelfCompactionCount(CID);

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 10000, output: 5000 })],
      }),
    });

    await handleLargeContextCompletion(CID, makeConfig(), ctx, noopLogger);

    expect(getSelfCompactionCount(CID)).toBe(0);
  });

  it("sets returnDeferred when context does not fit on original model", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(CID, "test-agent");
    setCurrentModel(CID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(CID, "anthropic", "claude-sonnet-4");
    setRestoreModel(CID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 20000);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 50000, output: 10000 })],
      }),
    });

    await handleLargeContextCompletion(CID, config, ctx, noopLogger);

    expect(isReturnDeferred(CID)).toBe(true);
    expect(getLargeContextPhase(CID)).toBe("active");
  });
});

describe("compaction loop prevention", () => {
  const SID = "test-loop-prevention";

  afterEach(() => {
    cleanupSession(SID);
  });

  it("manual /compact overflow: large model switch → compaction → context fits → switch back", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 10000, output: 5000 })],
      }),
    });

    setLargeContextPhase(SID, "summarizing");
    await handleLargeContextCompletion(SID, config, ctx, noopLogger);

    expect(getLargeContextPhase(SID)).toBeUndefined();
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        }),
      }),
    );
  });

  it("manual /compact overflow: large model switch → compaction → context doesn't fit → stay on large", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 20000);
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 50000, output: 10000 })],
      }),
    });

    setLargeContextPhase(SID, "summarizing");
    await handleLargeContextCompletion(SID, config, ctx, noopLogger);

    expect(getLargeContextPhase(SID)).toBe("active");
    expect(isReturnDeferred(SID)).toBe(true);
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-2.5-pro" },
        }),
      }),
    );
  });

  it("unknown model limit treated as unsafe for switch-back", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 50000, output: 10000 })],
      }),
    });

    setLargeContextPhase(SID, "summarizing");
    await handleLargeContextCompletion(SID, config, ctx, noopLogger);

    expect(getLargeContextPhase(SID)).toBe("active");
    expect(isReturnDeferred(SID)).toBe(true);
  });
});

describe("error handler compaction target routing", () => {
  const SID = "test-error-routing";

  afterEach(() => {
    cleanupSession(SID);
  });

  it("active phase + default target → routes to handleLargeContextReturn", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    setModelContextLimit("google/gemini-2.5-pro", 1000000);
    setLargeContextPhase(SID, "active");
    setCompactionTarget(SID, "default");
    setOpencodeCompacting(SID);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = createMockContext({ summarize: mockSummarize });

    await handleSessionError(config, noopLogger, ctx, {
      type: "session.error",
      properties: {
        sessionID: SID,
        error: {
          name: "Error",
          data: {
            message: "context length exceeded",
            statusCode: 400,
          },
        },
      },
    });

    expect(mockSummarize).toHaveBeenCalled();
    expect(getLargeContextPhase(SID)).toBe("summarizing");
  });

  it("summarize failure clears opencodeCompacting", async () => {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    setModelContextLimit("google/gemini-2.5-pro", 1000000);
    setLargeContextPhase(SID, "active");
    setCompactionTarget(SID, "large");
    setOpencodeCompacting(SID);

    const config = makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });

    const mockSummarize = vi.fn().mockRejectedValue(new Error("compaction failed"));
    const ctx = createMockContext({ summarize: mockSummarize });

    await handleSessionError(config, noopLogger, ctx, {
      type: "session.error",
      properties: {
        sessionID: SID,
        error: {
          name: "Error",
          data: {
            message: "context length exceeded",
            statusCode: 400,
          },
        },
      },
    });

    expect(isOpencodeCompacting(SID)).toBe(false);
  });
});

describe("self-compaction in-flight guard helpers", () => {
  const SID = "test-self-compaction-helpers";

  afterEach(() => {
    cleanupSession(SID);
  });

  it("setSelfCompactionInFlight makes isSelfCompactionInFlight true", () => {
    expect(isSelfCompactionInFlight(SID)).toBe(false);
    setSelfCompactionInFlight(SID);
    expect(isSelfCompactionInFlight(SID)).toBe(true);
  });

  it("clearSelfCompactionInFlight makes isSelfCompactionInFlight false", () => {
    setSelfCompactionInFlight(SID);
    expect(isSelfCompactionInFlight(SID)).toBe(true);
    clearSelfCompactionInFlight(SID);
    expect(isSelfCompactionInFlight(SID)).toBe(false);
  });

  it("cleanupSession clears the in-flight guard", () => {
    setSelfCompactionInFlight(SID);
    expect(isSelfCompactionInFlight(SID)).toBe(true);
    cleanupSession(SID);
    expect(isSelfCompactionInFlight(SID)).toBe(false);
  });
});

describe("session idle self-compaction re-entry guard", () => {
  const SID = "test-idle-self-compaction-guard";

  afterEach(() => {
    cleanupSession(SID);
  });

  function setupAtThreshold(): FallbackConfig {
    setRegisteredAgents(["test-agent"]);
    setSessionOriginalAgent(SID, "test-agent");
    setLargeContextPhase(SID, "active");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    setModelContextLimit("google/gemini-2.5-pro", 200000);
    return makeConfig({
      agents: { "test-agent": { largeContextModel: "google/gemini-2.5-pro" } },
    });
  }

  it("skips summarize when self-compaction already in flight", async () => {
    const config = setupAtThreshold();
    setSelfCompactionInFlight(SID);

    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = createMockContext({
      summarize: mockSummarize,
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 199600, output: 50, reasoning: 50 })],
      }),
    });

    await handleSessionIdle(config, noopLogger, ctx, {
      type: "session.idle",
      properties: { sessionID: SID },
    });

    expect(mockSummarize).not.toHaveBeenCalled();
    expect(isSelfCompactionInFlight(SID)).toBe(true);
  });

  it("self-compacts once and clears the in-flight guard when not already in flight", async () => {
    const config = setupAtThreshold();
    expect(isSelfCompactionInFlight(SID)).toBe(false);

    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = createMockContext({
      summarize: mockSummarize,
      messages: vi.fn().mockResolvedValue({
        data: [makeAssistantMessage({ input: 199600, output: 50, reasoning: 50 })],
      }),
    });

    await handleSessionIdle(config, noopLogger, ctx, {
      type: "session.idle",
      properties: { sessionID: SID },
    });

    expect(mockSummarize).toHaveBeenCalledTimes(1);
    expect(isSelfCompactionInFlight(SID)).toBe(false);
  });
});

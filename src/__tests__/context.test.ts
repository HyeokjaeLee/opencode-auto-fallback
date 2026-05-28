import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSession, setCurrentModel, setModelContextLimit } from "@/state/context-state";
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

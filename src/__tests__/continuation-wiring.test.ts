import { afterEach, describe, expect, it, vi } from "vitest";

const monitorMock = vi.hoisted(() => ({
  monitorContinuationActivity: vi.fn(() => ({ suppress: vi.fn() })),
}));

vi.mock("@/utils/continuation-monitor", () => ({
  monitorContinuationActivity: monitorMock.monitorContinuationActivity,
}));

import type { FallbackConfig } from "@/config/types";
import { handleLargeContextCompletion, handleLargeContextSwitch } from "@/core/large-context";
import {
  cleanupSession,
  getOrSetOriginalModel,
  setCurrentModel,
  setLargeContextPhase,
  setModelContextLimit,
  setRegisteredAgents,
  setRestoreModel,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { removeSession } from "@/state/session-state";

import { createMockContext } from "./mocks";

const SID = "continuation-wiring-sid";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeConfig(): FallbackConfig {
  return {
    enabled: true,
    autoUpdate: false,
    defaultFallback: [],
    defaultLargeContextModel: false,
    defaultMinContextRatio: 0.1,
    agents: { big: { largeContextModel: "google/gemini-2.5-pro" } },
    cooldownMs: 60_000,
    maxRetries: 2,
    logging: false,
  };
}

function makeMessages() {
  return [
    {
      info: { id: "u1", role: "user", sessionID: SID, agent: "big" },
      parts: [{ type: "text", text: "task" }],
    },
    {
      info: {
        role: "assistant",
        tokens: { input: 100, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    },
  ];
}

afterEach(() => {
  cleanupSession(SID);
  removeSession(SID);
  setRegisteredAgents([]);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("continuation monitor wiring (issue #7)", () => {
  it("monitors the large-context switch continuation", async () => {
    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: makeMessages() }),
    });

    const switched = await handleLargeContextSwitch(
      SID,
      { providerID: "google", modelID: "gemini-2.5-pro" },
      ctx,
      noopLogger,
      "Context at 99%",
    );

    expect(switched).toBe(true);
    expect(monitorMock.monitorContinuationActivity).toHaveBeenCalledWith(SID, ctx, noopLogger);
  });

  it("suppresses the monitor when the switch continuation prompt rejects", async () => {
    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");

    const suppress = vi.fn();
    monitorMock.monitorContinuationActivity.mockReturnValueOnce({ suppress });

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: makeMessages() }),
      // First prompt (notification) resolves; continuation prompt rejects.
      prompt: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("request aborted")),
    });

    await handleLargeContextSwitch(
      SID,
      { providerID: "google", modelID: "gemini-2.5-pro" },
      ctx,
      noopLogger,
      "Context at 99%",
    );

    await vi.waitFor(() => expect(suppress).toHaveBeenCalled());
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuation prompt failed"),
      expect.any(Object),
    );
  });

  it("monitors the still-too-large continuation in handleLargeContextCompletion", async () => {
    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setLargeContextPhase(SID, "summarizing");

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: makeMessages() }),
    });

    await handleLargeContextCompletion(SID, makeConfig(), ctx, noopLogger);

    // Original model limit unknown → cannot return → stays on the large model.
    expect(monitorMock.monitorContinuationActivity).toHaveBeenCalledWith(SID, ctx, noopLogger);
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  it("does not monitor the awaited switch-back prompt", async () => {
    setRegisteredAgents(["big"]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "google", "gemini-2.5-pro");
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");
    setRestoreModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    setLargeContextPhase(SID, "summarizing");

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: makeMessages() }),
    });

    await handleLargeContextCompletion(SID, makeConfig(), ctx, noopLogger);

    // Context fits on the original model → awaited switch-back prompt, no monitor.
    expect(monitorMock.monitorContinuationActivity).not.toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        }),
      }),
    );
  });
});

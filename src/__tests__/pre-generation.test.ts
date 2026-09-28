import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  config: {
    enabled: true,
    autoUpdate: false,
    defaultFallback: [],
    defaultLargeContextModel: false as const,
    defaultMinContextRatio: 0.1,
    agents: {},
    cooldownMs: 60_000,
    maxRetries: 2,
    logging: false,
  },
}));

vi.mock("@/config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/config")>();
  return { ...actual, loadConfig: vi.fn(() => hoisted.config) };
});

import { createPlugin } from "@/core/plugin";
import {
  cleanupSession,
  getLargeContextPhase,
  getOrSetOriginalModel,
  getSessionOriginalAgent,
  setCurrentModel,
  setLargeContextEligibleAgents,
  setModelContextLimit,
  setRegisteredAgents,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { markModelCooldown } from "@/state/provider-state";
import { removeSession } from "@/state/session-state";

import { createMockContext } from "./mocks";

const SID = "pre-generation-sid";

function makeMessages(withUserParts: boolean) {
  const userMessage = {
    info: { id: "u1", role: "user", sessionID: SID, agent: "big" },
    parts: [{ type: "text", text: "do the task" }],
  };
  const assistantMessage = {
    info: {
      role: "assistant",
      tokens: { input: 199600, output: 50, reasoning: 50, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
  return withUserParts ? [userMessage, assistantMessage] : [assistantMessage];
}

async function buildChatParams(ctx: ReturnType<typeof createMockContext>) {
  const hooks = (await createPlugin(ctx)) as Record<string, unknown>;
  return hooks["chat.params"] as (input: object, output: object) => Promise<void>;
}

function chatParamsInput(model: { providerID: string; modelID: string }) {
  return {
    sessionID: SID,
    agent: "big",
    // chat.params receives the SDK shape: { providerID, id }.
    model: { providerID: model.providerID, id: model.modelID, limit: { context: 200000 } },
    provider: {},
  };
}

/** Common state for an at-threshold session running agent `big`. */
function setupThresholdSession(currentModel: { providerID: string; modelID: string }): void {
  setRegisteredAgents(["big"]);
  setLargeContextEligibleAgents(["big"]);
  setSessionOriginalAgent(SID, "big");
  setCurrentModel(SID, currentModel.providerID, currentModel.modelID);
  setModelContextLimit("anthropic/claude-sonnet-4", 200000);
  getOrSetOriginalModel(SID, currentModel.providerID, currentModel.modelID);
}

afterEach(() => {
  cleanupSession(SID);
  removeSession(SID);
  setRegisteredAgents([]);
  setLargeContextEligibleAgents([]);
  vi.restoreAllMocks();
});

describe("pre-generation large-context switch (issue #5)", () => {
  it("switches to the large model at threshold with a single abort", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-2.5-pro" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-2.5-pro" },
          agent: "big",
        }),
      }),
    );
    expect(getLargeContextPhase(SID)).toBe("active");
  });

  it("aborts without switching when the session already runs the large model", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-2.5-pro" } };
    setupThresholdSession({ providerID: "google", modelID: "gemini-2.5-pro" });
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "google", modelID: "gemini-2.5-pro" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("aborts without switching when the large model is in cooldown", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-3-pro" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    setModelContextLimit("google/gemini-3-pro", 1000000);
    markModelCooldown("google", "gemini-3-pro", 60_000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("aborts without switching when the large window gain is below minContextRatio", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-small" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    setModelContextLimit("google/gemini-small", 200000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(getLargeContextPhase(SID)).toBeUndefined();
  });

  it("attempts the switch when the large model limit is unknown", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-unknown" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-unknown" },
        }),
      }),
    );
  });

  it("aborts exactly once when the switch fails (no duplicate abort)", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-2.5-pro" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      // No user parts → fetchSessionData finds nothing → switch fails.
      messages: vi.fn().mockResolvedValue({ data: makeMessages(false) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(getLargeContextPhase(SID)).toBeUndefined();
  });

  it("aborts for fallback-only agents (no large model configured)", async () => {
    hoisted.config.agents = { big: { fallback: ["zai/glm-5.1"] } };
    setRegisteredAgents(["big"]);
    setLargeContextEligibleAgents([]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      prompt: mockPrompt,
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("defers for subagent sessions without aborting (issue #4)", async () => {
    hoisted.config.agents = { big: { largeContextModel: "google/gemini-2.5-pro" } };
    setupThresholdSession({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    setModelContextLimit("google/gemini-2.5-pro", 1000000);

    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      prompt: mockPrompt,
      get: vi.fn().mockResolvedValue({ data: { id: SID, parentID: "parent-1" } }),
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(chatParamsInput({ providerID: "anthropic", modelID: "claude-sonnet-4" }), { options: {} });

    expect(mockAbort).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("still records the original agent before threshold handling", async () => {
    hoisted.config.agents = {};
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: makeMessages(true) }),
    });

    await (
      await buildChatParams(ctx)
    )(
      {
        sessionID: SID,
        agent: "unconfigured-agent",
        model: { providerID: "anthropic", id: "claude-sonnet-4", limit: { context: 200000 } },
        provider: {},
      },
      { options: {} },
    );

    expect(getSessionOriginalAgent(SID)).toBe("unconfigured-agent");
  });
});

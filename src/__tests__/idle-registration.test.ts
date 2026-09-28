import { afterEach, describe, expect, it, vi } from "vitest";

import type { FallbackConfig } from "@/config/types";
import { handleSessionIdle } from "@/hooks/handle-session-idle";
import {
  cleanupSession,
  getLargeContextPhase,
  setCurrentModel,
  setLargeContextEligibleAgents,
  setModelContextLimit,
  setRegisteredAgents,
  setSessionOriginalAgent,
} from "@/state/context-state";
import { getOrSetOriginalModel } from "@/state/context-state";
import { removeSession } from "@/state/session-state";

import { createMockContext } from "./mocks";

const SID = "idle-registration-sid";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    enabled: true,
    autoUpdate: false,
    defaultFallback: [],
    defaultLargeContextModel: false,
    defaultMinContextRatio: 0.1,
    agents: {},
    cooldownMs: 60_000,
    maxRetries: 2,
    logging: false,
    ...overrides,
  };
}

function makeAssistantMessage() {
  return {
    info: {
      role: "assistant",
      tokens: { input: 199600, output: 50, reasoning: 50, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
}

function makeUserMessage(agent: string) {
  return {
    info: { id: "u1", role: "user", sessionID: SID, agent },
    parts: [{ type: "text", text: "do the task" }],
  };
}

/** Simulates the config hook's registration side effects. */
function applyRegistration(names: string[], eligible: string[]): void {
  setRegisteredAgents(names);
  setLargeContextEligibleAgents(eligible);
}

afterEach(() => {
  cleanupSession(SID);
  removeSession(SID);
  setRegisteredAgents([]);
  setLargeContextEligibleAgents([]);
  vi.clearAllMocks();
});

describe("idle compaction for fallback-only agents (issue #3)", () => {
  it("leaves compaction to opencode when no agent is large-context eligible", async () => {
    const config = makeConfig({ agents: { "fb-only": { fallback: ["zai/glm-5.1"] } } });
    applyRegistration(["fb-only"], []);
    setSessionOriginalAgent(SID, "fb-only");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);

    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = createMockContext({
      summarize: mockSummarize,
      messages: vi.fn().mockResolvedValue({ data: [makeAssistantMessage()] }),
    });

    await handleSessionIdle(config, noopLogger, ctx, {
      type: "session.idle",
      properties: { sessionID: SID },
    });

    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it("manually compacts a fallback-only agent when another agent disabled auto-compaction", async () => {
    const config = makeConfig({
      agents: {
        "fb-only": { fallback: ["zai/glm-5.1"] },
        big: { largeContextModel: "google/gemini-2.5-pro" },
      },
    });
    applyRegistration(["fb-only", "big"], ["big"]);
    setSessionOriginalAgent(SID, "fb-only");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);

    const mockSummarize = vi.fn().mockResolvedValue({ data: null });
    const ctx = createMockContext({
      summarize: mockSummarize,
      messages: vi.fn().mockResolvedValue({ data: [makeAssistantMessage()] }),
    });

    await handleSessionIdle(config, noopLogger, ctx, {
      type: "session.idle",
      properties: { sessionID: SID },
    });

    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      }),
    );
  });

  it("still switches to the large model for eligible agents", async () => {
    const config = makeConfig({
      agents: { big: { largeContextModel: "google/gemini-2.5-pro" } },
    });
    applyRegistration(["big"], ["big"]);
    setSessionOriginalAgent(SID, "big");
    setCurrentModel(SID, "anthropic", "claude-sonnet-4");
    setModelContextLimit("anthropic/claude-sonnet-4", 200000);
    setModelContextLimit("google/gemini-2.5-pro", 1000000);
    getOrSetOriginalModel(SID, "anthropic", "claude-sonnet-4");

    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({
        data: [makeUserMessage("big"), makeAssistantMessage()],
      }),
    });

    await handleSessionIdle(config, noopLogger, ctx, {
      type: "session.idle",
      properties: { sessionID: SID },
    });

    expect(getLargeContextPhase(SID)).toBe("active");
    expect(ctx.client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "google", modelID: "gemini-2.5-pro" },
        }),
      }),
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  config: {
    enabled: true,
    autoUpdate: false,
    defaultFallback: ["zai/glm-5.1"],
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
  getSessionOriginalAgent,
  isRegisteredAgent,
  setRegisteredAgents,
} from "@/state/context-state";
import { removeSession } from "@/state/session-state";

import { createMockContext } from "./mocks";

const SESSION = "registration-session";

async function buildHooks() {
  return createPlugin(createMockContext());
}

function configHook(hooks: Record<string, unknown>): (input: object) => Promise<void> {
  return hooks.config as (input: object) => Promise<void>;
}

function chatParamsHook(
  hooks: Record<string, unknown>,
): (input: object, output: object) => Promise<void> {
  return hooks["chat.params"] as (input: object, output: object) => Promise<void>;
}

afterEach(() => {
  setRegisteredAgents([]);
  removeSession(SESSION);
  vi.restoreAllMocks();
});

describe("V1 config hook registration (issue #3)", () => {
  it("registers fallback-only agents and keeps native auto-compaction enabled", async () => {
    hoisted.config.agents = { "fb-only": { fallback: ["zai/glm-5.1"] } };
    const hooks = (await buildHooks()) as Record<string, unknown>;

    const input: Record<string, unknown> = {};
    await configHook(hooks)(input);

    expect(isRegisteredAgent("fb-only")).toBe(true);
    expect(input.compaction).toBeUndefined();
  });

  it("disables native auto-compaction only when a large-context agent is eligible", async () => {
    hoisted.config.agents = { big: { largeContextModel: "zai/glm-5.3" } };
    const hooks = (await buildHooks()) as Record<string, unknown>;

    const input: Record<string, unknown> = {};
    await configHook(hooks)(input);

    expect((input.compaction as { auto?: boolean }).auto).toBe(false);
  });

  it("clears stale registration state when no agents are configured", async () => {
    setRegisteredAgents(["stale-agent"]);
    hoisted.config.agents = {};
    const hooks = (await buildHooks()) as Record<string, unknown>;

    await configHook(hooks)({});

    expect(isRegisteredAgent("stale-agent")).toBe(false);
  });
});

describe("chat.params original-agent recording (issue #3)", () => {
  it("records the original agent even for default-only configs", async () => {
    hoisted.config.agents = {};
    const hooks = (await buildHooks()) as Record<string, unknown>;

    await chatParamsHook(hooks)(
      {
        sessionID: SESSION,
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", limit: { context: 200000 } },
        provider: {},
      },
      { options: {} },
    );

    expect(getSessionOriginalAgent(SESSION)).toBe("build");
  });
});

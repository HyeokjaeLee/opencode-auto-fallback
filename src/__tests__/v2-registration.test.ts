import { afterEach, describe, expect, it, vi } from "vitest";

import type { FallbackConfig } from "@/config/types";
import { isRegisteredAgent } from "@/state/context-state";
import { setupV2 } from "@/v2";

const hoisted = vi.hoisted(() => {
  const config: FallbackConfig = {
    enabled: true,
    autoUpdate: false,
    defaultFallback: ["zai/glm-5.1"],
    defaultLargeContextModel: false,
    defaultMinContextRatio: 0.1,
    agents: {
      "v2-fallback-only": { fallback: ["zai/glm-5.1"] },
    },
    cooldownMs: 60000,
    maxRetries: 2,
    logging: false,
  };
  return { config };
});

vi.mock("@/config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config/config")>();
  return { ...actual, loadConfig: vi.fn(() => hoisted.config) };
});

function createMockV2Context() {
  return {
    session: {
      hook: vi.fn().mockResolvedValue(undefined),
    },
    event: {
      // Finite async iterable: subscribeEvents() drains it and exits cleanly.
      subscribe: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
      })),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V2 agent registration", () => {
  it("registers fallback-only agents without a large-context model", async () => {
    const ctx = createMockV2Context();
    const cleanup = await setupV2(ctx as never);
    expect(isRegisteredAgent("v2-fallback-only")).toBe(true);
    cleanup();
  });
});

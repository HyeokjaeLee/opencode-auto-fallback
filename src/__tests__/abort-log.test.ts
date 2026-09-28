import { afterEach, describe, expect, it, vi } from "vitest";

import type { FallbackConfig } from "@/config/types";
import { handleSessionError } from "@/hooks/handle-session-error";
import { cleanupSession, consumePluginAbortMark, markPluginAbort } from "@/state/context-state";
import { removeSession } from "@/state/session-state";

import { createMockContext } from "./mocks";

const SESSION = "abort-log-session";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function abortEvent() {
  return {
    type: "session.error",
    properties: {
      sessionID: SESSION,
      error: { name: "MessageAbortedError", data: { message: "aborted by user" } },
    },
  };
}

afterEach(() => {
  cleanupSession(SESSION);
  removeSession(SESSION);
  vi.clearAllMocks();
});

describe("abort event attribution (issue #7)", () => {
  it("logs a plugin-initiated abort when the session was marked by the plugin", async () => {
    markPluginAbort(SESSION);
    await handleSessionError(makeConfig(), noopLogger, createMockContext(), abortEvent());

    const messages = noopLogger.info.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain("Plugin-initiated abort (fallback/switch), ignoring");
    expect(messages).not.toContain("User-initiated abort, ignoring");
    // mark is single-use
    expect(consumePluginAbortMark(SESSION)).toBe(false);
  });

  it("logs a user-initiated abort for unmarked sessions", async () => {
    await handleSessionError(makeConfig(), noopLogger, createMockContext(), abortEvent());

    const messages = noopLogger.info.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain("User-initiated abort, ignoring");
    expect(messages).not.toContain("Plugin-initiated abort (fallback/switch), ignoring");
  });

  it("a consumed mark cannot mislabel a later user abort", async () => {
    markPluginAbort(SESSION);
    await handleSessionError(makeConfig(), noopLogger, createMockContext(), abortEvent());
    await handleSessionError(makeConfig(), noopLogger, createMockContext(), abortEvent());

    const messages = noopLogger.info.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain("Plugin-initiated abort (fallback/switch), ignoring");
    expect(messages).toContain("User-initiated abort, ignoring");
  });

  it("does not consume the mark for other error types", async () => {
    markPluginAbort(SESSION);
    await handleSessionError(makeConfig(), noopLogger, createMockContext(), {
      type: "session.error",
      properties: {
        sessionID: SESSION,
        error: { name: "AI_APICallError", data: { message: "usage limit reached" } },
      },
    });

    expect(consumePluginAbortMark(SESSION)).toBe(true);
  });
});

function makeConfig(): FallbackConfig {
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
  };
}

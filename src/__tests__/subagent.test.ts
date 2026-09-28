import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABORT_DELAY_MS,
  ABORT_TIMEOUT_MS,
  SUBAGENT_IDLE_POLL_INTERVAL_MS,
  SUBAGENT_IDLE_TIMEOUT_MS,
} from "@/config/constants";
import { consumePluginAbortMark } from "@/state/context-state";
import { isSubagentSession, prepareSessionForPrompt, waitForSessionIdle } from "@/utils/subagent";

import { createMockContext } from "./mocks";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  consumePluginAbortMark("child-session");
  consumePluginAbortMark("root-session");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isSubagentSession", () => {
  it("detects a child session via parentID", async () => {
    const ctx = createMockContext({
      get: vi.fn().mockResolvedValue({ data: { id: "child-session", parentID: "parent-1" } }),
    });
    expect(await isSubagentSession("child-session", ctx, noopLogger)).toBe(true);
  });

  it("detects a root session when parentID is absent", async () => {
    const ctx = createMockContext();
    expect(await isSubagentSession("root-session", ctx, noopLogger)).toBe(false);
  });

  it("returns undefined when session metadata is unavailable", async () => {
    const ctx = createMockContext({ get: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await isSubagentSession("root-session", ctx, noopLogger)).toBeUndefined();
  });
});

describe("waitForSessionIdle", () => {
  it("returns immediately when the status map has no entry for the session", async () => {
    const ctx = createMockContext();
    expect(await waitForSessionIdle("root-session", ctx, noopLogger)).toBe(true);
  });

  it("waits for a busy session to become idle", async () => {
    let calls = 0;
    const ctx = createMockContext({
      status: vi.fn(() => {
        calls++;
        return Promise.resolve({ data: calls < 3 ? { "root-session": { type: "busy" } } : {} });
      }),
    });
    const pending = waitForSessionIdle("root-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_POLL_INTERVAL_MS * 5);
    await expect(pending).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("gives up with false when the session never becomes idle", async () => {
    const ctx = createMockContext({
      status: vi.fn().mockResolvedValue({ data: { "root-session": { type: "busy" } } }),
    });
    const pending = waitForSessionIdle("root-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TIMEOUT_MS + SUBAGENT_IDLE_POLL_INTERVAL_MS);
    await expect(pending).resolves.toBe(false);
  });

  it("never treats a failed status response as idle", async () => {
    const ctx = createMockContext({
      status: vi.fn().mockRejectedValue(new Error("endpoint missing")),
    });
    const pending = waitForSessionIdle("root-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TIMEOUT_MS + SUBAGENT_IDLE_POLL_INTERVAL_MS);
    await expect(pending).resolves.toBe(false);
  });
});

describe("prepareSessionForPrompt (issue #4)", () => {
  it("aborts root sessions and marks the plugin abort", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ abort: mockAbort });
    const pending = prepareSessionForPrompt("root-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS + ABORT_DELAY_MS);
    await expect(pending).resolves.toBe("aborted");
    expect(mockAbort).toHaveBeenCalledWith({ path: { id: "root-session" } });
    expect(consumePluginAbortMark("root-session")).toBe(true);
  });

  it("never aborts child sessions and prompts only after idle", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      get: vi.fn().mockResolvedValue({ data: { id: "child-session", parentID: "parent-1" } }),
    });
    const pending = prepareSessionForPrompt("child-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_POLL_INTERVAL_MS * 2);
    await expect(pending).resolves.toBe("ready");
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("skips the prompt when a child never becomes idle", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      get: vi.fn().mockResolvedValue({ data: { id: "child-session", parentID: "parent-1" } }),
      status: vi.fn().mockResolvedValue({ data: { "child-session": { type: "busy" } } }),
    });
    const pending = prepareSessionForPrompt("child-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_TIMEOUT_MS + SUBAGENT_IDLE_POLL_INTERVAL_MS);
    await expect(pending).resolves.toBe("not-ready");
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("uses the abort-free path when ownership is unknown", async () => {
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({
      abort: mockAbort,
      get: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const pending = prepareSessionForPrompt("root-session", ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(SUBAGENT_IDLE_POLL_INTERVAL_MS * 2);
    await expect(pending).resolves.toBe("ready");
    expect(mockAbort).not.toHaveBeenCalled();
  });
});

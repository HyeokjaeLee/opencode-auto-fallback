import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupSession,
  clearPluginAbortMark,
  consumePluginAbortMark,
  markPluginAbort,
} from "@/state/context-state";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanupSession("session-abort-test");
  vi.useRealTimers();
});

describe("plugin abort marks", () => {
  it("consumes a fresh mark exactly once", () => {
    markPluginAbort("session-abort-test");
    expect(consumePluginAbortMark("session-abort-test")).toBe(true);
    expect(consumePluginAbortMark("session-abort-test")).toBe(false);
  });

  it("returns false for sessions that were never marked", () => {
    expect(consumePluginAbortMark("session-abort-test")).toBe(false);
  });

  it("treats stale marks as not plugin-initiated", () => {
    markPluginAbort("session-abort-test");
    vi.advanceTimersByTime(10_001);
    expect(consumePluginAbortMark("session-abort-test")).toBe(false);
  });

  it("does not leak marks across deleted sessions", () => {
    markPluginAbort("session-abort-test");
    cleanupSession("session-abort-test");
    expect(consumePluginAbortMark("session-abort-test")).toBe(false);
  });

  it("explicit clear drops the mark", () => {
    markPluginAbort("session-abort-test");
    clearPluginAbortMark("session-abort-test");
    expect(consumePluginAbortMark("session-abort-test")).toBe(false);
  });
});

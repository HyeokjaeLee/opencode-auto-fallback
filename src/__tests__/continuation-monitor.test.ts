import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTINUATION_VERIFY_POLL_INTERVAL_MS,
  CONTINUATION_VERIFY_TIMEOUT_MS,
} from "@/config/constants";
import { monitorContinuationActivity } from "@/utils/continuation-monitor";

import { createMockContext } from "./mocks";

const SID = "continuation-monitor-sid";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function assistantMessage(id: string, partCount: number) {
  return {
    info: { id, role: "assistant" },
    parts: Array.from({ length: partCount }, () => ({ type: "text", text: "x" })),
  };
}

function userMessage(id: string) {
  return {
    info: { id, role: "user" },
    parts: [{ type: "text", text: "noReply notification" }],
  };
}

function loggerMessages(fn: typeof noopLogger.info): string[] {
  return fn.mock.calls.map((call) => String(call[0]));
}

/** Drives the detached monitor past its full observation window. */
async function runToTimeout(): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    CONTINUATION_VERIFY_TIMEOUT_MS + CONTINUATION_VERIFY_POLL_INTERVAL_MS * 2,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("monitorContinuationActivity (issue #7)", () => {
  it("verifies when a new assistant message appears", async () => {
    let calls = 0;
    const ctx = createMockContext({
      messages: vi.fn(() => {
        calls++;
        return Promise.resolve({
          data:
            calls === 1
              ? [assistantMessage("a1", 1)]
              : [assistantMessage("a1", 1), assistantMessage("a2", 0)],
        });
      }),
    });

    monitorContinuationActivity(SID, ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(CONTINUATION_VERIFY_POLL_INTERVAL_MS * 2);

    expect(loggerMessages(noopLogger.info)).toContain(
      "Continuation verified: new assistant activity observed",
    );
    expect(noopLogger.error).not.toHaveBeenCalled();
  });

  it("verifies when the last assistant message gains parts", async () => {
    let calls = 0;
    const ctx = createMockContext({
      messages: vi.fn(() => {
        calls++;
        return Promise.resolve({
          data: [assistantMessage("a1", calls === 1 ? 1 : 3)],
        });
      }),
    });

    monitorContinuationActivity(SID, ctx, noopLogger);
    await vi.advanceTimersByTimeAsync(CONTINUATION_VERIFY_POLL_INTERVAL_MS * 2);

    expect(loggerMessages(noopLogger.info)).toContain(
      "Continuation verified: new assistant activity observed",
    );
  });

  it("reports a lost continuation when history never changes", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [assistantMessage("a1", 2)] }),
    });

    monitorContinuationActivity(SID, ctx, noopLogger);
    await runToTimeout();

    expect(loggerMessages(noopLogger.error)).toContain(
      "continuation lost — caller process likely exited (e.g. opencode run)",
    );
  });

  it("does not count notification-only user messages as continuation activity", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [assistantMessage("a1", 1), userMessage("u1")] }),
    });

    monitorContinuationActivity(SID, ctx, noopLogger);
    await runToTimeout();

    expect(noopLogger.info).not.toHaveBeenCalledWith(
      "Continuation verified: new assistant activity observed",
      expect.any(Object),
    );
    expect(loggerMessages(noopLogger.error)).toContain(
      "continuation lost — caller process likely exited (e.g. opencode run)",
    );
  });

  it("distinguishes failed observations from confirmed inactivity", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockRejectedValue(new Error("connection refused")),
    });

    monitorContinuationActivity(SID, ctx, noopLogger);
    await runToTimeout();

    expect(loggerMessages(noopLogger.warn)).toContain(
      "Continuation could not be verified (session observations failed)",
    );
    expect(noopLogger.error).not.toHaveBeenCalled();
  });

  it("suppress() prevents lost-continuation logging", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockResolvedValue({ data: [assistantMessage("a1", 1)] }),
    });

    const handle = monitorContinuationActivity(SID, ctx, noopLogger);
    handle.suppress();
    await runToTimeout();

    expect(noopLogger.error).not.toHaveBeenCalled();
  });

  it("never leaks an unhandled rejection", async () => {
    const ctx = createMockContext({
      messages: vi.fn().mockRejectedValue(new Error("boom")),
    });

    monitorContinuationActivity(SID, ctx, {
      info: vi.fn().mockRejectedValue(new Error("logger down")),
      warn: vi.fn(),
      error: vi.fn(),
    });

    await expect(runToTimeout()).resolves.toBeUndefined();
  });
});

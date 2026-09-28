import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ABORT_DELAY_MS, ABORT_TIMEOUT_MS } from "@/config/constants";
import { consumePluginAbortMark } from "@/state/context-state";
import { abortSession, abortSessionSafely } from "@/utils/session-utils";

import { createMockContext } from "./mocks";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  consumePluginAbortMark("s");
  vi.useRealTimers();
});

/** Drives abortSession to completion under fake timers. */
async function runAbort(
  context: ReturnType<typeof createMockContext>,
): Promise<ReturnType<typeof createMockContext>> {
  const pending = abortSession("s", context);
  await vi.advanceTimersByTimeAsync(ABORT_DELAY_MS);
  await pending;
  return context;
}

describe("abortSession (bounded, issue #6)", () => {
  it("finishes normally when abort resolves and keeps the plugin-abort mark", async () => {
    const context = await runAbort(createMockContext());
    expect(context.client.session.abort).toHaveBeenCalledWith({ path: { id: "s" } });
    expect(consumePluginAbortMark("s")).toBe(true);
  });

  it("swallows abort rejection, clears the mark, and still waits the delay", async () => {
    const context = createMockContext({
      abort: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    await expect(runAbort(context)).resolves.toBeDefined();
    expect(consumePluginAbortMark("s")).toBe(false);
  });

  it("finishes when abort hangs forever and keeps the mark (abort may still land)", async () => {
    const context = createMockContext({
      abort: vi.fn(() => new Promise(() => {})),
    });
    const pending = abortSession("s", context);
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS + ABORT_DELAY_MS);
    await pending;
    expect(consumePluginAbortMark("s")).toBe(true);
  });

  it("does not raise an unhandled rejection when abort rejects after the timeout", async () => {
    let rejectAbort!: (err: Error) => void;
    const context = createMockContext({
      abort: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectAbort = reject;
          }),
      ),
    });
    const pending = abortSession("s", context);
    await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS);
    rejectAbort(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(ABORT_DELAY_MS);
    await expect(pending).resolves.toBeUndefined();
  });

  it("abortSessionSafely delegates to the same bounded behavior", async () => {
    const context = createMockContext({
      abort: vi.fn().mockRejectedValue(new Error("gone")),
    });
    const pending = abortSessionSafely("s", context);
    await vi.advanceTimersByTimeAsync(ABORT_DELAY_MS);
    await expect(pending).resolves.toBeUndefined();
  });
});

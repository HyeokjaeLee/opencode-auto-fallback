import { afterEach, describe, expect, it, vi } from "vitest";

import { isPrefillNotSupportedError } from "@/core/decision";
import { handlePrefillNotSupportedRetry } from "@/core/fallback";
import {
  getPrefillRetryCount,
  incrementPrefillRetryCount,
  removeSession,
  resetPrefillRetryCount,
} from "@/state/session-state";
import { buildPrefillRetryNotificationPart } from "@/utils/fallback-notification";
import type { Logger } from "@/utils/session-utils";

import { createMockContext } from "./mocks";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const SESSION = "prefill-test-session";

afterEach(() => {
  removeSession(SESSION);
  vi.clearAllMocks();
});

describe("isPrefillNotSupportedError", () => {
  it("matches 'does not support assistant message prefill'", () => {
    expect(
      isPrefillNotSupportedError("This model does not support assistant message prefill."),
    ).toBe(true);
  });

  it("matches 'must end with a user message'", () => {
    expect(isPrefillNotSupportedError("The conversation must end with a user message.")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isPrefillNotSupportedError("DOES NOT SUPPORT ASSISTANT MESSAGE PREFILL")).toBe(true);
  });

  it("does not match unrelated messages", () => {
    expect(isPrefillNotSupportedError("rate limit exceeded")).toBe(false);
    expect(isPrefillNotSupportedError("message length exceeds token limit")).toBe(false);
    expect(isPrefillNotSupportedError("context window exceeded")).toBe(false);
  });
});

describe("prefill retry counter state", () => {
  it("starts at 0", () => {
    expect(getPrefillRetryCount(SESSION)).toBe(0);
  });

  it("increments", () => {
    expect(incrementPrefillRetryCount(SESSION)).toBe(1);
    expect(incrementPrefillRetryCount(SESSION)).toBe(2);
  });

  it("resets", () => {
    incrementPrefillRetryCount(SESSION);
    resetPrefillRetryCount(SESSION);
    expect(getPrefillRetryCount(SESSION)).toBe(0);
  });
});

describe("buildPrefillRetryNotificationPart", () => {
  it("formats with error name and action, no model name", () => {
    const part = buildPrefillRetryNotificationPart("Prefill not supported", "Retrying same model");
    expect(part.type).toBe("text");
    expect(part.text).toContain("[Prefill not supported / Retrying same model]");
    expect(part.text).toContain("<!-- OPENCODE_AUTO_FALLBACK -->");
    expect(part.text).not.toMatch(/→/);
  });
});

describe("handlePrefillNotSupportedRetry", () => {
  it("first occurrence re-prompts same model with Continue and returns 'retried'", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("retried");
    expect(getPrefillRetryCount(SESSION)).toBe(1);
    expect(abort).toHaveBeenCalledTimes(1);

    const tuiCall = prompt.mock.calls.find((c) => c[0]?.body?.noReply === true);
    expect(tuiCall).toBeDefined();
    const tuiPart = tuiCall?.[0]?.body?.parts?.[0];
    expect(tuiPart?.text).toContain("[Prefill not supported / Retrying same model]");

    const agentCall = prompt.mock.calls.find((c) => c[0]?.body?.noReply !== true);
    expect(agentCall).toBeDefined();
    expect(agentCall?.[0]?.body?.parts?.[0]?.text).toBe("Continue");
    expect(agentCall?.[0]?.body?.parts?.[0]?.synthetic).toBe(true);
    expect(agentCall?.[0]?.body?.model).toBeUndefined();
  });

  it("second occurrence falls through without re-prompting (sticky counter)", async () => {
    incrementPrefillRetryCount(SESSION);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("fallthrough");
    expect(getPrefillRetryCount(SESSION)).toBe(1);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("falls through and resets when the re-prompt throws", async () => {
    const prompt = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("prompt failed"));
    const abort = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("fallthrough");
    expect(getPrefillRetryCount(SESSION)).toBe(0);
  });

  it("reverts trailing assistant message before re-prompting", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const messages = vi.fn().mockResolvedValue({
      data: [{ info: { id: "msg-1", role: "assistant" }, parts: [] }],
    });
    const revert = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort, messages, revert });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("retried");
    expect(revert).toHaveBeenCalledTimes(1);
    expect(revert).toHaveBeenCalledWith({
      path: { id: SESSION },
      body: { messageID: "msg-1" },
    });
  });

  it("does not call revert when last message is user", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const messages = vi.fn().mockResolvedValue({
      data: [{ info: { id: "msg-1", role: "user" }, parts: [] }],
    });
    const revert = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort, messages, revert });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("retried");
    expect(revert).not.toHaveBeenCalled();
  });

  it("does not call revert when messages list is empty", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const messages = vi.fn().mockResolvedValue({ data: [] });
    const revert = vi.fn().mockResolvedValue(undefined);
    const ctx = createMockContext({ prompt, abort, messages, revert });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("retried");
    expect(revert).not.toHaveBeenCalled();
  });

  it("continues with prompt when revert fails", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const messages = vi.fn().mockResolvedValue({
      data: [{ info: { id: "msg-1", role: "assistant" }, parts: [] }],
    });
    const revert = vi.fn().mockRejectedValue(new Error("revert failed"));
    const ctx = createMockContext({ prompt, abort, messages, revert });

    const result = await handlePrefillNotSupportedRetry(SESSION, noopLogger, ctx);

    expect(result).toBe("retried");
    const agentCall = prompt.mock.calls.find((c) => c[0]?.body?.noReply !== true);
    expect(agentCall).toBeDefined();
  });
});

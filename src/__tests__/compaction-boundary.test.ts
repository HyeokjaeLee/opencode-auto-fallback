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

import { enforceCompactionBoundary } from "@/core/message";
import type { PromptInputMessage } from "@/core/message";
import { createPlugin } from "@/core/plugin";
import { clearNativeCompaction, isNativeCompactionInFlight } from "@/state/context-state";
import { waitForNativeCompaction } from "@/utils/compaction-wait";

import { createMockContext } from "./mocks";

const SESSION = "compaction-boundary-session";

function user(id: string, parts: PromptInputMessage["parts"]): PromptInputMessage {
  return { info: { id, role: "user" }, parts };
}

function assistant(id: string, info: Partial<PromptInputMessage["info"]> = {}): PromptInputMessage {
  return {
    info: { id, role: "assistant", ...info },
    parts: [{ type: "text", text: "summary" }],
  };
}

function completeSummary(
  id: string,
  parentID: string,
  extra?: Partial<PromptInputMessage["info"]>,
): PromptInputMessage {
  return assistant(id, { parentID, summary: true, finish: "stop", ...extra });
}

function textUser(id: string): PromptInputMessage {
  return user(id, [{ type: "text", text: id }]);
}

function compactionUser(id: string, tailStartId?: string): PromptInputMessage {
  const part: Record<string, unknown> & { type: string } = { type: "compaction" };
  if (tailStartId) part.tail_start_id = tailStartId;
  return user(id, [part]);
}

/** filterCompacted output when the pair is broken: full history, pair mid-array. */
function brokenBoundary(): PromptInputMessage[] {
  return [
    textUser("old1"),
    textUser("old2"),
    compactionUser("c1"),
    completeSummary("s1", "c1"),
    textUser("post1"),
  ];
}

afterEach(() => {
  clearNativeCompaction(SESSION);
  vi.useRealTimers();
});

describe("enforceCompactionBoundary", () => {
  it("returns unchanged when there is no compaction pair", () => {
    const messages = [textUser("u1"), assistant("a1", { finish: "stop" })];
    const result = enforceCompactionBoundary(messages);
    expect(result.messages).toBe(messages);
    expect(result.cutCount).toBe(0);
  });

  it("returns unchanged when the boundary is intact (pair at front, as filterCompacted emits)", () => {
    const messages = [
      compactionUser("c1", "t1"),
      completeSummary("s1", "c1"),
      textUser("t1"),
      textUser("post1"),
    ];
    const result = enforceCompactionBoundary(messages);
    expect(result.messages).toBe(messages);
    expect(result.cutCount).toBe(0);
  });

  it("cuts pre-compaction messages before a completed pair mid-array", () => {
    const messages = brokenBoundary();
    const result = enforceCompactionBoundary(messages);
    expect(result.cutCount).toBe(2);
    expect(result.messages.map((m) => m.info.id)).toEqual(["c1", "s1", "post1"]);
  });

  it("preserves tail messages after the summary, matching upstream filterCompacted order", () => {
    const messages = [
      textUser("old1"),
      textUser("tail1"),
      compactionUser("c1", "tail1"),
      completeSummary("s1", "c1"),
      textUser("post1"),
    ];
    const result = enforceCompactionBoundary(messages);
    expect(result.cutCount).toBe(1);
    expect(result.messages.map((m) => m.info.id)).toEqual(["c1", "s1", "tail1", "post1"]);
  });

  it("falls back to cutting everything before the pair when tail_start_id is missing", () => {
    const messages = [
      textUser("old1"),
      compactionUser("c1", "ghost"),
      completeSummary("s1", "c1"),
      textUser("post1"),
    ];
    const result = enforceCompactionBoundary(messages);
    expect(result.cutCount).toBe(1);
    expect(result.messages.map((m) => m.info.id)).toEqual(["c1", "s1", "post1"]);
  });

  it("cuts at the older completed pair when the newest summary errored", () => {
    const messages = [
      textUser("old1"),
      compactionUser("c1"),
      completeSummary("s1", "c1"),
      compactionUser("c2"),
      completeSummary("s2", "c2", { error: { name: "MessageAbortedError" } }),
      textUser("post1"),
    ];
    const result = enforceCompactionBoundary(messages);
    expect(result.cutCount).toBe(1);
    expect(result.messages.map((m) => m.info.id)).toEqual(["c1", "s1", "c2", "s2", "post1"]);
  });

  it("does not recognize a summary with finish but an error as a completed pair", () => {
    const messages = [
      textUser("old1"),
      compactionUser("c1"),
      completeSummary("s1", "c1", { error: { name: "MessageAbortedError" } }),
      textUser("post1"),
    ];
    const result = enforceCompactionBoundary(messages);
    expect(result.messages).toBe(messages);
    expect(result.cutCount).toBe(0);
  });

  it("is idempotent on its own output", () => {
    const first = enforceCompactionBoundary(brokenBoundary());
    expect(first.cutCount).toBe(2);
    const second = enforceCompactionBoundary(first.messages);
    expect(second.cutCount).toBe(0);
    expect(second.messages).toBe(first.messages);
  });
});

describe("plugin compaction wiring", () => {
  it("registers the messages transform hook and mutates the array in place", async () => {
    const hooks = (await createPlugin(createMockContext())) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: object,
      output: { messages: PromptInputMessage[] },
    ) => Promise<void>;
    expect(transform).toBeTypeOf("function");

    const messages = brokenBoundary();
    const output = { messages };
    await transform({}, output);

    expect(output.messages).toBe(messages);
    expect(messages.map((m) => m.info.id)).toEqual(["c1", "s1", "post1"]);
  });

  it("marks the session on session.compacting and clears it", async () => {
    const hooks = (await createPlugin(createMockContext())) as Record<string, unknown>;
    const compacting = hooks["experimental.session.compacting"] as (
      input: { sessionID: string },
      output: { context: string[] },
    ) => Promise<void>;

    expect(isNativeCompactionInFlight(SESSION)).toBe(false);
    await compacting({ sessionID: SESSION }, { context: [] });
    expect(isNativeCompactionInFlight(SESSION)).toBe(true);

    clearNativeCompaction(SESSION);
    expect(isNativeCompactionInFlight(SESSION)).toBe(false);
  });
});

describe("waitForNativeCompaction", () => {
  it("resolves true immediately when nothing is in flight", async () => {
    await expect(waitForNativeCompaction(() => false, 1_000, 50)).resolves.toBe(true);
  });

  it("resolves true when the flag clears within the timeout", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const promise = waitForNativeCompaction(
      () => {
        polls++;
        return polls >= 2;
      },
      5_000,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false on timeout", async () => {
    vi.useFakeTimers();
    const promise = waitForNativeCompaction(() => true, 500, 100);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(false);
  });
});

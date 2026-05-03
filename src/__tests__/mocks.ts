import { vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

export function createMockContext(overrides?: {
  abort?: ReturnType<typeof vi.fn>;
  children?: ReturnType<typeof vi.fn>;
  messages?: ReturnType<typeof vi.fn>;
  prompt?: ReturnType<typeof vi.fn>;
  revert?: ReturnType<typeof vi.fn>;
  showToast?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  summarize?: ReturnType<typeof vi.fn>;
  status?: ReturnType<typeof vi.fn>;
}) {
  const mockAbort = overrides?.abort ?? vi.fn().mockResolvedValue(undefined);
  const mockChildren = overrides?.children ?? vi.fn().mockResolvedValue({ data: [] });
  const mockMessages = overrides?.messages ?? vi.fn().mockResolvedValue({ data: [] });
  const mockPrompt = overrides?.prompt ?? vi.fn().mockResolvedValue(undefined);
  const mockRevert =
    overrides?.revert ??
    vi.fn().mockResolvedValue({ response: { status: 200 }, data: { revert: {} } });
  const mockShowToast = overrides?.showToast ?? vi.fn().mockResolvedValue(true);
  const mockGet =
    overrides?.get ?? vi.fn().mockResolvedValue({ data: { id: "test-session", title: "test" } });
  const mockSummarize = overrides?.summarize ?? vi.fn().mockResolvedValue({ data: null });
  const mockStatus = overrides?.status ?? vi.fn().mockResolvedValue({ data: {} });

  return {
    client: {
      session: {
        abort: mockAbort,
        children: mockChildren,
        get: mockGet,
        messages: mockMessages,
        prompt: mockPrompt,
        revert: mockRevert,
        summarize: mockSummarize,
        status: mockStatus,
      },
      tui: {
        showToast: mockShowToast,
      },
    },
    directory: "/mock/dir",
  } as unknown as PluginInput;
}

export function createMockMessages(opts: {
  sessionID?: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  userText?: string;
  assistantText?: string;
}) {
  const sid = opts.sessionID ?? "test-session";
  return [
    {
      info: { id: "msg-u1", role: "user", sessionID: sid, agent: opts.agent },
      parts: [{ id: "p1", type: "text", text: opts.userText ?? "hello" }],
    },
    {
      // SDK AssistantMessage has providerID/modelID as flat properties
      info: {
        id: "msg-a1",
        role: "assistant",
        sessionID: sid,
        providerID: opts.providerID,
        modelID: opts.modelID ?? "test-model",
      },
      parts: [{ id: "p2", type: "text", text: opts.assistantText ?? "response" }],
    },
  ];
}

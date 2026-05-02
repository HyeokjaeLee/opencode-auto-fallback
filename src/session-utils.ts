import type { PluginInput } from "@opencode-ai/plugin";
import type { ToastOptions } from "./types";
import { ABORT_DELAY_MS } from "./constants";
import { createLogger } from "./log";
import { extractUserParts } from "./message";
import type { Message as SDKMessage, Part as SDKPart } from "@opencode-ai/sdk";
import { adaptMessages, getModelFromMessage } from "./adapters/sdk-adapter";
import { getCurrentModel } from "./state/context-state";

/** tui is available at runtime but not typed in the SDK */
interface ToastClient {
  showToast(params: { body: ToastOptions }): Promise<unknown>;
}

export type ClientWithTui = PluginInput["client"] & { tui?: ToastClient };

export interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

export type Logger = ReturnType<typeof createLogger>;

export async function showToastSafely(
  context: PluginInput,
  body: ToastOptions,
  logger: Logger,
): Promise<void> {
  try {
    const client = context.client as ClientWithTui;
    await client.tui?.showToast({ body });
  } catch (err) {
    await logger.warn("Toast failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function abortSession(
  sessionID: string,
  context: PluginInput,
): Promise<void> {
  await context.client.session.abort({ path: { id: sessionID } });
  await new Promise((resolve) => setTimeout(resolve, ABORT_DELAY_MS));
}

export async function fetchSessionData(
  sessionID: string,
  context: PluginInput,
  logger: Logger,
  hookInput?: ChatMessageInput,
) {
  const messagesResponse = await context.client.session.messages({
    path: { id: sessionID },
  });
  const raw = (messagesResponse.data ?? []) as Array<{
    info: SDKMessage;
    parts: SDKPart[];
  }>;
  const messages = adaptMessages(raw);
  let extracted = extractUserParts(messages);
  if (!extracted) {
    await logger.info(
      "No user parts found (non-synthetic), retrying with synthetic allowed",
      { sessionID },
    );
    extracted = extractUserParts(messages, { allowSynthetic: true });
  }
  const lastAssistant = [...raw]
    .reverse()
    .find((m) => m.info.role === "assistant");
  const currentModel = lastAssistant
    ? getModelFromMessage(lastAssistant.info)
    : (hookInput?.model ?? getCurrentModel(sessionID));
  return { messages, extracted, currentModel };
}

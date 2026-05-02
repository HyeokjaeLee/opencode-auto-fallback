import type { Message as SDKMessage, Part as SDKPart } from "@opencode-ai/sdk"
import type { MessageInfo, MessagePart, MessageWithParts } from "../types"

function toMessageInfo(msg: SDKMessage): MessageInfo {
  if (msg.role === "assistant") {
    return {
      id: msg.id,
      role: "assistant",
      sessionID: msg.sessionID,
      model: { providerID: msg.providerID, modelID: msg.modelID },
    }
  }
  return {
    id: msg.id,
    role: "user",
    sessionID: msg.sessionID,
    agent: msg.agent,
    model: msg.model,
  }
}

function toMessagePart(part: SDKPart): MessagePart {
  const base: MessagePart = { id: part.id, type: part.type }
  switch (part.type) {
    case "text":
      return { ...base, text: part.text, synthetic: part.synthetic }
    case "file":
      return { ...base, mime: part.mime, filename: part.filename, url: part.url }
    case "agent":
      return { ...base, name: part.name }
    default:
      return base
  }
}

export function adaptMessages(raw: Array<{ info: SDKMessage; parts: SDKPart[] }>): MessageWithParts[] {
  return raw.map(({ info, parts }) => ({
    info: toMessageInfo(info),
    parts: parts.map(toMessagePart),
  }))
}

export function getModelFromMessage(msg: SDKMessage): { providerID: string; modelID: string } {
  if (msg.role === "assistant") {
    return { providerID: msg.providerID, modelID: msg.modelID }
  }
  return msg.model
}

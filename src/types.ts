export interface ResolvedModel {
  providerID: string
  modelID: string
}

export type ModelReference = string | ResolvedModel

export type AgentFallbackMap = Record<string, ModelReference>

export interface FallbackConfig {
  enabled: boolean
  defaultFallback: ModelReference
  agentFallbacks: AgentFallbackMap
  cooldownMs: number
  patterns: string[]
  logging: boolean
}

export interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
}

export interface MessageInfo {
  id: string
  role: "user" | "assistant"
  sessionID: string
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

export interface MessagePart {
  id: string
  type: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
}

export interface MessageWithParts {
  info: MessageInfo
  parts: MessagePart[]
}

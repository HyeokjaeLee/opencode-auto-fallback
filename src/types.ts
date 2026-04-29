export interface ResolvedModel {
  providerID: string
  modelID: string
}

export interface FallbackModel extends ResolvedModel {
  variant?: string
}

export type ModelReference = string | ResolvedModel

export type FallbackEntry = string | FallbackModel

export type AgentFallbackMap = Record<string, FallbackEntry[]>

export interface FallbackConfig {
  enabled: boolean
  defaultFallback: FallbackEntry[]
  agentFallbacks: AgentFallbackMap
  cooldownMs: number
  rateLimitRetries: number
  logging: boolean
}

export interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
  backoffLevel: number
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

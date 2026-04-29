export interface ResolvedModel {
  providerID: string
  modelID: string
}

export interface FallbackModel extends ResolvedModel {
  variant?: string
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  temperature?: number
  topP?: number
  maxTokens?: number
  thinking?: {
    type: "enabled" | "disabled"
    budgetTokens?: number
  }
}

export interface FallbackModelConfig {
  model: string
  variant?: string
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  temperature?: number
  topP?: number
  maxTokens?: number
  thinking?: {
    type: "enabled" | "disabled"
    budgetTokens?: number
  }
}

export type ModelReference = string | ResolvedModel

export type FallbackEntry = string | FallbackModel | FallbackModelConfig

export type AgentFallbackMap = Record<string, FallbackEntry[]>

export type ErrorClass = "immediate" | "retry" | "ignore"

export interface FallbackDecision {
  action: ErrorClass
  httpStatus?: number
  matchedPattern?: string
}

export interface FallbackConfig {
  enabled: boolean
  defaultFallback: FallbackEntry[]
  agentFallbacks: AgentFallbackMap
  cooldownMs: number
  maxRetries: number
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

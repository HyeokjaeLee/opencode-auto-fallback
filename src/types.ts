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

export interface LargeContextFallbackConfig {
  agents: string[]
  model: string
  /** Maps "provider/model" to context window token limit. Used to skip fallback when window sizes are too similar. */
  /** Minimum fractional increase in context window required to trigger fallback (default 0.1 = 10%) */
  minContextRatio?: number
}

export type FallbackEntry = string | FallbackModel | FallbackModelConfig

export type AgentFallbackMap = Record<string, FallbackEntry[]>

export type ErrorClass = "immediate" | "retry" | "ignore"

export interface FallbackDecision {
  action: ErrorClass
  httpStatus?: number
  isRetryable?: boolean
}

export interface FallbackConfig {
  enabled: boolean
  defaultFallback?: FallbackEntry[]
  agentFallbacks: AgentFallbackMap
  cooldownMs: number
  maxRetries: number
  logging: boolean
  largeContextFallback?: LargeContextFallbackConfig
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
  synthetic?: boolean
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

export type LargeContextPhase = "pending" | "active" | "summarizing"

export interface ToastOptions {
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration?: number
}

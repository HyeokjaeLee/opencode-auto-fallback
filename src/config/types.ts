export interface ResolvedModel {
  providerID: string;
  modelID: string;
}

export interface FallbackModel extends ResolvedModel {
  variant?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinking?: {
    type: "enabled" | "disabled";
    budgetTokens?: number;
  };
}

/** @deprecated Unused. Kept for API compatibility. */
export type ErrorClass = "immediate" | "retry" | "ignore";

export type FallbackEntry =
  | string
  | {
      model: string;
      variant?: string;
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
    };

/** @deprecated Unused. Kept for API compatibility. */
export type FallbackModelEntry = Extract<FallbackEntry, { model: string }>;

export interface FallbackDecision {
  action: ErrorClass;
  httpStatus?: number;
  isRetryable?: boolean;
}

export interface AgentConfig {
  fallback?: FallbackEntry[];
  /** Model to switch to when context fills up. false = explicitly disabled, undefined = inherit defaultLargeContextModel. */
  largeContextModel?: string | false;
  minContextRatio?: number;
}

export interface FallbackConfig {
  enabled: boolean;
  autoUpdate: boolean;
  defaultFallback?: FallbackEntry[];
  defaultLargeContextModel: string | false;
  defaultMinContextRatio: number;
  agents: Record<string, AgentConfig>;
  cooldownMs: number;
  maxRetries: number;
  logging: boolean;
}

export interface SessionState {
  fallbackActive: boolean;
  cooldownEndTime: number;
  backoffLevel: number;
}

export interface MessageInfo {
  id: string;
  role: "user" | "assistant";
  sessionID: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
}

export interface MessagePart {
  id: string;
  type: string;
  synthetic?: boolean;
  text?: string;
  mime?: string;
  filename?: string;
  url?: string;
  name?: string;
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

export type LargeContextPhase = "pending" | "active" | "summarizing";

export interface ToastOptions {
  title?: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
  duration?: number;
}

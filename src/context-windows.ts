/**
 * Built-in context window sizes for common models.
 * Used as a fallback when auto-detection from SDK or user config is unavailable.
 */
export const BUILTIN_CONTEXT_WINDOWS: Record<string, number> = {
  "opencode-go/deepseek-v4-flash": 131_072,
  "opencode-go/deepseek-v4-pro": 262_144,
  "anthropic/claude-sonnet-4": 200_000,
  "anthropic/claude-opus-4": 200_000,
  "anthropic/claude-haiku-3.5": 200_000,
  "openai/gpt-4o": 128_000,
  "openai/gpt-4o-mini": 128_000,
  "openai/gpt-5.5": 2_097_152,
  "openai/o3": 200_000,
  "google/gemini-2.5-flash": 1_048_576,
  "google/gemini-2.5-pro": 1_048_576,
  "zai-coding-plan/glm-5.1": 131_072,
  "deepseek/deepseek-chat": 131_072,
  "deepseek/deepseek-reasoner": 131_072,
  "zai-coding-plan/glm-4.5-air": 51200,
};

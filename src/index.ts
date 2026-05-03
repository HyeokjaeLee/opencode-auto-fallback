export { createPlugin as AutoFallbackPlugin } from "@/core/plugin";

export type {
  AgentFallbackMap,
  ErrorClass,
  FallbackConfig,
  FallbackDecision,
  FallbackEntry,
  FallbackModel,
  FallbackModelConfig,
  LargeContextFallbackConfig,
  ResolvedModel,
} from "@/config/types";

import { createPlugin } from "@/core/plugin";

export default createPlugin;

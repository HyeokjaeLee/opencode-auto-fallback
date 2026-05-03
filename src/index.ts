export { createPlugin as AutoFallbackPlugin } from "@/core/plugin";

export type {
  FallbackConfig,
  FallbackModel,
  FallbackModelConfig,
  FallbackEntry,
  ResolvedModel,
  AgentFallbackMap,
  FallbackDecision,
  ErrorClass,
  LargeContextFallbackConfig,
} from "@/config/types";

import { createPlugin } from "@/core/plugin";
export default createPlugin;

export type {
  AgentConfig,
  ErrorClass,
  FallbackConfig,
  FallbackDecision,
  FallbackEntry,
  FallbackModel,
  FallbackModelEntry,
  ResolvedModel,
} from "@/config/types";
export { createPlugin as AutoFallbackPlugin } from "@/core/plugin";

import { createPlugin } from "@/core/plugin";

export default createPlugin;

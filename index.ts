export { createPlugin as AutoFallbackPlugin } from "./src/plugin"

export type {
  FallbackConfig,
  FallbackModel,
  FallbackModelConfig,
  FallbackEntry,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
  FallbackDecision,
  ErrorClass,
  LargeContextFallbackConfig,
} from "./src/types"

import { createPlugin } from "./src/plugin"
export default createPlugin

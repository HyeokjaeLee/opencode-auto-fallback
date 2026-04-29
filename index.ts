export { createPlugin as AutoFallbackPlugin } from "./src/plugin"

export type {
  FallbackConfig,
  FallbackModel,
  FallbackEntry,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
  FallbackDecision,
  ErrorClass,
} from "./src/types"

import { createPlugin } from "./src/plugin"
export default createPlugin

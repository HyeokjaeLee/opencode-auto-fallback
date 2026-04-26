export { createPlugin as AutoFallbackPlugin } from "./src/plugin"

export type {
  FallbackConfig,
  ModelReference,
  ResolvedModel,
  AgentFallbackMap,
} from "./src/types"

import { createPlugin } from "./src/plugin"
export default createPlugin

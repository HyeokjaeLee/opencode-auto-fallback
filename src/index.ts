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
export { PLUGIN_ID, setupV2 } from "@/v2";
export type { V2ContextLike, V2ModelRef, V2SessionContext, V2SessionRetry } from "@/v2";

import { createPlugin } from "@/core/plugin";
import { PLUGIN_ID, setupV2 } from "@/v2";

/**
 * Dual V1 + V2 plugin entrypoint.
 *
 * OpenCode V2 (>= 2.0.x) reads `id` and `setup` from the default export and
 * calls `setup(ctx)` with the V2 plugin context. OpenCode V1 (>= 1.18.29) reads
 * the legacy `server` field and calls it with the V1 `PluginInput`. Older V1
 * releases (before object entrypoint support) require the named
 * `AutoFallbackPlugin` export instead.
 *
 * The object literal is written explicitly rather than spreading
 * `Plugin.define(...)` so the package keeps zero runtime dependency on
 * `@opencode/plugin` (whose `define` is an identity helper) and the emitted
 * declaration stays stable.
 */
const plugin = {
  id: PLUGIN_ID,
  setup: setupV2,
  server: createPlugin,
};

export default plugin;

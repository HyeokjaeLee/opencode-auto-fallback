import { describe, expect, it } from "vitest";

import plugin, { AutoFallbackPlugin, setupV2 } from "@/index";

import type { Plugin } from "@opencode/plugin";

// Compile-time contract check: the V2 adapter must stay assignable to the real
// V2 plugin setup signature. `tsc --noEmit` fails here if the V2 API drifts.
const _setupContract: Plugin.Plugin["setup"] = setupV2;
void _setupContract;

describe("dual V1/V2 default export", () => {
  it("exposes a stable V2 id", () => {
    expect(plugin.id).toBe("opencode-auto-fallback");
  });

  it("exposes a V2 setup function", () => {
    expect(typeof plugin.setup).toBe("function");
    expect(plugin.setup).toBe(setupV2);
  });

  it("exposes the V1 plugin function as server", () => {
    expect(typeof plugin.server).toBe("function");
    expect(plugin.server).toBe(AutoFallbackPlugin);
  });

  it("keeps the named V1 export available", () => {
    expect(typeof AutoFallbackPlugin).toBe("function");
  });
});

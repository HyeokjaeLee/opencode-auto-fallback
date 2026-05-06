import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: true,
  external: ["@opencode-ai/plugin"],
  tsconfig: "tsconfig.json",
});

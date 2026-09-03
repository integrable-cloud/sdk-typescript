import { defineConfig } from "tsup";

// Dual ESM + CJS, because a package that ships only one of them breaks half
// its consumers on install and the fix is always someone else's afternoon.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2022",
  outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});

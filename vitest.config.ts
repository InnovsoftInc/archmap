import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules"],
    // Commands the tests launch never ask GitHub for a newer archmap.
    env: { ARCHMAP_NO_UPDATE_CHECK: "1" },
    // Coverage is set up here but not turned on: the `test` script passes
    // `--coverage`, so `pnpm test` (and CI) still collect it, while running
    // one file by hand skips instrumenting the whole package.
    coverage: {
      provider: "istanbul",
      reporter: [["json", { file: "coverage.json" }]],
    },
  },
});

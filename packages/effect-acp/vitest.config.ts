import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

// Tests spawn cold `bun` mock peers; default 5s flakes under parallel turbo load.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);

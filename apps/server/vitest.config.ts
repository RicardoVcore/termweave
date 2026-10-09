import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      testTimeout: 15_000,
      hookTimeout: 15_000,
      // Keep test git repos hermetic from developer config (e.g. global core.hooksPath).
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  }),
);

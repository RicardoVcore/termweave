import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  noExternal: (id) => id.startsWith("@termweave/"),
  banner: {
    js: "#!/usr/bin/env bun\n",
  },
});

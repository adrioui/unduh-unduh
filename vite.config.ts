import { defineConfig } from "vite-plus";

export default defineConfig({
  appType: "spa",
  build: {
    outDir: "dist/client",
    target: "es2023",
  },
  publicDir: false,
  run: {
    tasks: {
      verify: {
        command: "pnpm run verify",
        cache: false,
      },
    },
  },
  staged: {
    "*.{css,html,ts}": "vp check --fix",
  },
});

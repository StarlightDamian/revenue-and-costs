import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});

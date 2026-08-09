import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  root: ".",
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
      "/health": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
    },
  },
});

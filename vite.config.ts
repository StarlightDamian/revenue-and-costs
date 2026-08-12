import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

function appBasePath(command: "build" | "serve", configuredValue: string | undefined): string {
  const value = configuredValue?.trim() || (command === "build" ? "/revenue-costs" : "/");
  const segments = value.split("/").slice(1);
  if (
    !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/u.test(value)
    || (value !== "/" && (value.endsWith("/") || segments.includes(".") || segments.includes("..")))
  ) {
    throw new Error("APP_BASE_PATH must be / or a safe absolute path without a trailing slash");
  }
  return value;
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredBasePath = appBasePath(command, process.env.APP_BASE_PATH ?? (command === "serve" ? env.APP_BASE_PATH : undefined));
  const base = configuredBasePath === "/" ? "/" : `${configuredBasePath}/`;
  const proxyTarget = process.env.API_PROXY_TARGET ?? env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";
  const proxyPath = (path: string) => configuredBasePath === "/" ? path : `${configuredBasePath}${path}`;
  const stripBasePath = (path: string) => configuredBasePath === "/" ? path : path.slice(configuredBasePath.length);

  return {
    base,
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
      sourcemap: env.BUILD_SOURCEMAP === "true",
    },
    server: {
      port: 5173,
      proxy: {
        [proxyPath("/api")]: { target: proxyTarget, rewrite: stripBasePath },
        [proxyPath("/health")]: { target: proxyTarget, rewrite: stripBasePath },
      },
    },
  };
});

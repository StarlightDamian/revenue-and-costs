import { reactive } from "vue";
import { api } from "./api/client";
import { ApiError } from "./api/http";
import type { Me } from "./api/types";
import { applyTheme, normalizeTheme } from "./theme";

export const session = reactive<{
  status: "loading" | "authenticated" | "anonymous" | "error";
  me: Me | null;
  error: string;
}>({ status: "loading", me: null, error: "" });

let inFlight: Promise<void> | null = null;

export function loadSession(force = false): Promise<void> {
  if (inFlight && !force) return inFlight;
  inFlight = (async () => {
    session.status = "loading";
    session.error = "";
    try {
      session.me = await api.getMe();
      session.status = "authenticated";
      applyTheme(normalizeTheme(session.me.theme));
    } catch (error) {
      session.me = null;
      if (error instanceof ApiError && error.status === 401) session.status = "anonymous";
      else {
        session.status = "error";
        session.error = error instanceof Error ? error.message : "无法读取登录状态";
      }
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export function acceptSession(me: Me): void {
  session.me = me;
  session.status = "authenticated";
  session.error = "";
  applyTheme(normalizeTheme(me.theme));
}

export function clearSession(): void {
  session.me = null;
  session.status = "anonymous";
}

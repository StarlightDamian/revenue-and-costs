import { loadConfig } from "../src/shared/config.js";

export function maintenanceDatabaseUrl(): string {
  if (process.env.NODE_ENV !== "production") return loadConfig().databaseUrl;
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL_MISSING");
  return value;
}

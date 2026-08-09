import { createApp } from "./app";
import { createPool } from "../db/pool";
import { loadConfig } from "../shared/config";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await createApp({ config, pool });

const close = async (): Promise<void> => {
  app.log.info({ event: "api_stopping", service: "api", pid: process.pid }, "api stopping");
  await app.close();
  await pool.end();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

await app.listen({ host: config.host, port: config.port });
app.log.info({ event: "api_started", service: "api", pid: process.pid, mode: config.mode }, "api started");

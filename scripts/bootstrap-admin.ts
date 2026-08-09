import { createPool } from "../src/db/pool.js";
import { createServiceGraph } from "../src/api/service-graph.js";
import { loadConfig } from "../src/shared/config.js";

const config = loadConfig();
const phone = process.env.BOOTSTRAP_ADMIN_PHONE;
if (!phone) throw new Error("缺少 BOOTSTRAP_ADMIN_PHONE（E.164 格式）");
const pool = createPool(config.databaseUrl);
try {
  const graph = createServiceGraph(config, pool);
  const account = await graph.auth.bootstrapAdministrator(phone);
  process.stdout.write(`首位管理员已初始化：${account.id}\n`);
} finally {
  await pool.end();
}

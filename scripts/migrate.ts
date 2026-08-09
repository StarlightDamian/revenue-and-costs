import { migrate } from "../src/db/migrate";
import { createPool } from "../src/db/pool";
import { loadConfig } from "../src/shared/config";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool);
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
} finally {
  await pool.end();
}

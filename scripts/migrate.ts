import { migrate } from "../src/db/migrate";
import { createPool } from "../src/db/pool";
import { maintenanceDatabaseUrl } from "./database-url.js";

const pool = createPool(maintenanceDatabaseUrl(), "cli");
try {
  const applied = await migrate(pool);
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
} finally {
  await pool.end();
}

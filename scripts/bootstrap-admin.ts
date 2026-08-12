import { createPool } from "../src/db/pool.js";
import { PostgresDatabase } from "../src/db/database.js";
import { normalizePhone } from "../src/modules/auth/crypto.js";
import { PostgresAuthRepository } from "../src/modules/auth/postgres.js";
import { PostgresMembershipArtifactInvalidator } from "../src/modules/exports/postgres-membership-invalidator.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const phone = process.env.BOOTSTRAP_ADMIN_PHONE;
if (!phone) throw new Error("缺少 BOOTSTRAP_ADMIN_PHONE（E.164 格式）");
const pool = createPool(databaseUrl, "cli");
try {
  const database = new PostgresDatabase(pool);
  const repository = new PostgresAuthRepository(
    database,
    database,
    new PostgresMembershipArtifactInvalidator(),
  );
  const account = await repository.bootstrapAdministrator(normalizePhone(phone), new Date());
  process.stdout.write(`首位管理员已初始化：${account.id}\n`);
} finally {
  await pool.end();
}

import type { Pool, PoolClient } from "pg";
import { AppError } from "../shared/errors.js";

const GLOBAL_EXPORT_SLOTS = 1;
const ACCOUNT_LOCK_PREFIX = "intermediate-export:account:";
const SLOT_LOCK_PREFIX = "intermediate-export:slot:";

export interface IntermediateExportLease {
  release(): Promise<void>;
}

async function tryLock(client: PoolClient, key: string): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
    [key],
  );
  return result.rows[0]?.acquired === true;
}

async function unlock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
}

/** Holds session advisory locks on one dedicated PostgreSQL connection. */
export async function acquireIntermediateExportLease(pool: Pool, accountId: string): Promise<IntermediateExportLease> {
  const client = await pool.connect();
  const accountKey = `${ACCOUNT_LOCK_PREFIX}${accountId}`;
  let slotKey: string | undefined;
  let accountLocked = false;
  try {
    accountLocked = await tryLock(client, accountKey);
    if (!accountLocked) {
      throw new AppError("INTERMEDIATE_EXPORT_ACCOUNT_BUSY", "当前账号已有中间结果正在导出", 429);
    }
    for (let index = 0; index < GLOBAL_EXPORT_SLOTS; index += 1) {
      const candidate = `${SLOT_LOCK_PREFIX}${index}`;
      if (await tryLock(client, candidate)) {
        slotKey = candidate;
        break;
      }
    }
    if (!slotKey) {
      throw new AppError("INTERMEDIATE_EXPORT_CAPACITY_BUSY", "中间结果导出繁忙，请稍后重试", 503);
    }
  } catch (error) {
    if (accountLocked) await unlock(client, accountKey).catch(() => undefined);
    client.release();
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await unlock(client, slotKey!);
        await unlock(client, accountKey);
      } finally {
        client.release();
      }
    },
  };
}

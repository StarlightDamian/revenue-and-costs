import type { Pool, PoolClient } from "pg";

export type RecoverableQueueName =
  | "storage.replicate"
  | "upload.finalize"
  | "import.analyze"
  | "import.commit"
  | "calculation.requested"
  | "calculation.run"
  | "report.auto-publish"
  | "export.generate";

function lockKey(queueName: RecoverableQueueName, businessId: string): string {
  return `worker-job:${queueName}:${businessId}`;
}

export interface JobExecutionKey {
  readonly queueName: RecoverableQueueName;
  readonly businessId: string;
}

let executionTail = Promise.resolve();

async function serializeWorkerExecution<T>(work: () => Promise<T>): Promise<T> {
  const previous = executionTail;
  let release!: () => void;
  executionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function unlock(client: PoolClient, key: string): Promise<boolean> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked",
      [key],
    );
    return result.rows[0]?.unlocked === true;
  } catch {
    return false;
  }
}

export async function withJobExecutionLock<T>(
  pool: Pool,
  queueName: RecoverableQueueName,
  businessId: string,
  work: (lockClient: PoolClient) => Promise<T>,
): Promise<T> {
  return withJobExecutionLocks(pool, [{ queueName, businessId }], work);
}

export async function withJobExecutionLocks<T>(
  pool: Pool,
  jobs: readonly JobExecutionKey[],
  work: (lockClient: PoolClient) => Promise<T>,
): Promise<T> {
  return serializeWorkerExecution(async () => {
    const client = await pool.connect();
    const keys = [...new Set(jobs.map((job) => lockKey(job.queueName, job.businessId)))].sort();
    const acquired: string[] = [];
    let acquiring = true;
    let destroyClient = false;
    try {
      for (const key of keys) {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
        acquired.push(key);
      }
      acquiring = false;
      return await work(client);
    } catch (error) {
      if (acquiring) destroyClient = true;
      throw error;
    } finally {
      for (const key of acquired.reverse()) {
        if (!await unlock(client, key)) destroyClient = true;
      }
      if (destroyClient) client.release(true);
      else client.release();
    }
  });
}

export async function tryWithJobExecutionLock<T>(
  pool: Pool,
  queueName: RecoverableQueueName,
  businessId: string,
  work: (lockClient: PoolClient) => Promise<T>,
): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
  return serializeWorkerExecution(async () => {
    const client = await pool.connect();
    const key = lockKey(queueName, businessId);
    let acquired = false;
    let destroyClient = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [key],
      );
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) return { acquired: false };
      return { acquired: true, value: await work(client) };
    } catch (error) {
      if (!acquired) destroyClient = true;
      throw error;
    } finally {
      if (acquired && !await unlock(client, key)) destroyClient = true;
      if (destroyClient) client.release(true);
      else client.release();
    }
  });
}

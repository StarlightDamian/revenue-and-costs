import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool";

interface PendingEvent { id: string; topic: string; business_key: string; payload: Record<string, unknown> }

const durableJobOptions = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 6 * 60 * 60,
  heartbeatSeconds: 30,
} as const;

export async function dispatchOutbox(pool: Pool, boss: PgBoss, limit = 50): Promise<number> {
  let claimedIds: string[] = [];
  try {
    return await withTransaction(pool, async (tx) => {
      const result = await tx.query<PendingEvent>(
        `SELECT id, topic, business_key, payload
         FROM outbox_event WHERE dispatched_at IS NULL
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      claimedIds = result.rows.map((event) => event.id);
      const byTopic = new Map<string, PendingEvent[]>();
      for (const event of result.rows) {
        const group = byTopic.get(event.topic) ?? [];
        group.push(event);
        byTopic.set(event.topic, group);
      }
      for (const [topic, events] of byTopic) {
        await boss.insert(topic, events.map((event) => ({
          data: event.payload,
          singletonKey: event.id,
          ...durableJobOptions,
        })));
      }
      if (result.rows.length) {
        await tx.query(
          `UPDATE outbox_event
              SET dispatched_at=clock_timestamp(),attempt_count=attempt_count+1,last_error=NULL
            WHERE id=ANY($1::uuid[])`,
          [claimedIds],
        );
      }
      return result.rowCount ?? 0;
    });
  } catch (error) {
    if (claimedIds.length) {
      await pool.query(
        `UPDATE outbox_event
            SET attempt_count=attempt_count+1,last_error=$2
          WHERE id=ANY($1::uuid[]) AND dispatched_at IS NULL`,
        [claimedIds, "OUTBOX_DISPATCH_FAILED"],
      ).catch(() => undefined);
    }
    throw error;
  }
}

export function createOutboxDispatchScheduler(
  run: () => Promise<number>,
  batchLimit: number,
  reportError: (error: unknown) => void,
): { wake: () => void; stop: () => Promise<void> } {
  if (!Number.isInteger(batchLimit) || batchLimit < 1) throw new Error("OUTBOX_BATCH_LIMIT_INVALID");
  let requested = false;
  let running = false;
  let stopped = false;
  let active = Promise.resolve();

  const start = () => {
    if (running || stopped) return;
    running = true;
    active = (async () => {
      try {
        do {
          requested = false;
          let count: number;
          do {
            count = await run();
          } while (!stopped && count >= batchLimit);
        } while (!stopped && requested);
      } catch (error) {
        reportError(error);
      } finally {
        running = false;
        if (!stopped && requested) start();
      }
    })();
  };

  const wake = () => {
    if (stopped) return;
    requested = true;
    start();
  };

  return {
    wake,
    async stop() {
      stopped = true;
      await active;
    },
  };
}

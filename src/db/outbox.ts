import type { Transaction } from "./pool";

export interface OutboxMessage {
  topic: string;
  businessKey: string;
  payload: Record<string, unknown>;
}

export async function enqueueOutbox(tx: Transaction, event: OutboxMessage): Promise<string> {
  const result = await tx.query<{ id: string }>(
    `INSERT INTO outbox_event (topic, business_key, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (topic, business_key) DO UPDATE SET topic = EXCLUDED.topic
     RETURNING id`,
    [event.topic, event.businessKey, JSON.stringify(event.payload)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("OUTBOX_INSERT_FAILED");
  return row.id;
}

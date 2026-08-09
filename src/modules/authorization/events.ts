import { randomUUID } from 'node:crypto';
import type { AuditRecord, SqlClient, TransactionSideEffects } from './index.js';

export class CoreTransactionSideEffects implements TransactionSideEffects {
  async audit(client: SqlClient, record: AuditRecord): Promise<void> {
    await client.query(
      `INSERT INTO audit_event
        (actor_account_id, action, object_type, object_id, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        record.actorAccountId,
        record.action,
        record.objectType,
        record.objectId,
        record.reason,
        JSON.stringify({
          actorRoles: record.actorRoles,
          result: record.result,
          requestId: record.requestId,
          before: record.before,
          after: record.after,
        }),
      ],
    );
  }

  async outbox(
    client: SqlClient,
    event: {
      readonly eventId: string;
      readonly eventType: string;
      readonly businessKey: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_event (id, topic, business_key, payload)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (topic, business_key) DO NOTHING`,
      [event.eventId || randomUUID(), event.eventType, event.businessKey, JSON.stringify(event.payload)],
    );
  }
}

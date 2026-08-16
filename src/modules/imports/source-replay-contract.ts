import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface SourceReplayClosureRow {
  readonly dataset_version_id: string;
  readonly report_kind: string;
  readonly import_file_id: string;
  readonly stored_object_id: string | null;
  readonly mapping_version_id: string | null;
}

export function sourceReplayClosureHash(rows: readonly SourceReplayClosureRow[]): string {
  const closure = rows.map((row) => ({
    datasetVersionId: row.dataset_version_id,
    reportKind: row.report_kind,
    importFileId: row.import_file_id,
    storedObjectId: row.stored_object_id,
    mappingVersionId: row.mapping_version_id,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(closure)).digest("hex");
}

export interface InheritedSourceReplayAcknowledgements {
  readonly acknowledgementIds: readonly string[];
}

const INHERITED_HARD_INCOMPLETE_REASON = "受控源数据重放后，缺少配送货件的切片与上一不可变版本的交易事实完全一致，沿用已确认的排除决定。";

export async function inheritSourceReplayHardAcknowledgements(
  client: PoolClient,
  batchId: string,
  actorAccountId: string,
): Promise<InheritedSourceReplayAcknowledgements> {
  const result = await client.query<{ acknowledgement_id: string }>(
    `WITH replay AS (
       SELECT batch.id batch_id,batch.shop_id
         FROM import_batch batch
         JOIN account actor ON actor.id=$2 AND actor.status='ACTIVE'
         JOIN account_role role ON role.account_id=actor.id AND role.role='ADMIN'
        WHERE batch.id=$1 AND batch.idempotency_key LIKE 'admin-source-replay:%'
          AND EXISTS (
            SELECT 1 FROM audit_event created
             WHERE created.object_type='import_batch' AND created.object_id=batch.id
               AND created.action='ADMIN_SOURCE_REPLAY_CREATED'
               AND created.actor_account_id=batch.created_by
               AND created.metadata->>'shopId'=batch.shop_id::text
               AND created.metadata->>'sourceMode'='CURRENT_BINDING_CLOSURE'
               AND created.metadata->>'completenessRuleVersion'='shipment-only-v1'
          )
     ), candidate AS (
       SELECT current.id dataset_version_id,previous.id predecessor_version_id,
              prior_ack.id predecessor_acknowledgement_id,prior_ack.confirmation_count,
              policy.id policy_id,replay.shop_id
         FROM replay
         JOIN dataset_version current ON current.import_batch_id=replay.batch_id
          AND current.status='INCOMPLETE'
         JOIN dataset_slice slice ON slice.id=current.dataset_slice_id
          AND slice.shop_id=replay.shop_id AND slice.current_version_id=current.id
         JOIN dataset_version previous ON previous.id=current.supersedes_version_id
          AND previous.dataset_slice_id=current.dataset_slice_id
          AND previous.status='SUPERSEDED'
         JOIN LATERAL (
           SELECT acknowledgement.id,acknowledgement.marketplace_policy_version_id,
                  acknowledgement.confirmation_count
             FROM quality_acknowledgement acknowledgement
            WHERE acknowledgement.dataset_version_id=previous.id
              AND acknowledgement.calculation_run_id IS NULL
              AND acknowledgement.issue_kind='HARD_INCOMPLETE'
              AND acknowledgement.issue_code='ACCOUNTANT_ACKNOWLEDGED'
            ORDER BY acknowledgement.created_at DESC,acknowledgement.id DESC LIMIT 1
         ) prior_ack ON true
         JOIN LATERAL (
           SELECT policy.id
             FROM marketplace_policy_version policy
            WHERE policy.normalized_marketplace=slice.normalized_marketplace
              AND policy.effective_from<=current.created_at
              AND (policy.effective_to IS NULL OR policy.effective_to>current.created_at)
            ORDER BY policy.effective_from DESC,policy.id DESC LIMIT 1
         ) policy ON policy.id=prior_ack.marketplace_policy_version_id
        WHERE NOT EXISTS (SELECT 1 FROM shipment_fact fact WHERE fact.dataset_version_id=current.id)
          AND NOT EXISTS (SELECT 1 FROM shipment_fact fact WHERE fact.dataset_version_id=previous.id)
          AND EXISTS (SELECT 1 FROM transaction_fact fact WHERE fact.dataset_version_id=current.id)
          AND EXISTS (SELECT 1 FROM transaction_fact fact WHERE fact.dataset_version_id=previous.id)
          AND EXISTS (
            SELECT 1 FROM dataset_source_binding binding
             WHERE binding.dataset_version_id=current.id AND binding.report_kind='TRANSACTION'
          )
          AND EXISTS (
            SELECT 1 FROM dataset_source_binding binding
             WHERE binding.dataset_version_id=previous.id AND binding.report_kind='TRANSACTION'
          )
          AND NOT EXISTS (
            SELECT 1 FROM dataset_source_binding binding
             WHERE binding.dataset_version_id IN (current.id,previous.id)
               AND binding.report_kind<>'TRANSACTION'
          )
          AND NOT EXISTS (
            SELECT 1 FROM (
              (SELECT binding.report_kind,binding.mapping_version_id,file.stored_object_id
                 FROM dataset_source_binding binding
                 JOIN import_file file ON file.id=binding.import_file_id
                WHERE binding.dataset_version_id=current.id
               EXCEPT ALL
               SELECT binding.report_kind,binding.mapping_version_id,file.stored_object_id
                 FROM dataset_source_binding binding
                 JOIN import_file file ON file.id=binding.import_file_id
                WHERE binding.dataset_version_id=previous.id)
              UNION ALL
              (SELECT binding.report_kind,binding.mapping_version_id,file.stored_object_id
                 FROM dataset_source_binding binding
                 JOIN import_file file ON file.id=binding.import_file_id
                WHERE binding.dataset_version_id=previous.id
               EXCEPT ALL
               SELECT binding.report_kind,binding.mapping_version_id,file.stored_object_id
                 FROM dataset_source_binding binding
                 JOIN import_file file ON file.id=binding.import_file_id
                WHERE binding.dataset_version_id=current.id)
            ) difference
          )
          AND NOT EXISTS (
            SELECT 1 FROM (
              (SELECT file.stored_object_id,fact.row_number,
                      to_jsonb(fact)-ARRAY['id','dataset_version_id','source_file_id','created_at']::text[] payload
                 FROM transaction_fact fact
                 JOIN import_file file ON file.id=fact.source_file_id
                WHERE fact.dataset_version_id=current.id
               EXCEPT ALL
               SELECT file.stored_object_id,fact.row_number,
                      to_jsonb(fact)-ARRAY['id','dataset_version_id','source_file_id','created_at']::text[] payload
                 FROM transaction_fact fact
                 JOIN import_file file ON file.id=fact.source_file_id
                WHERE fact.dataset_version_id=previous.id)
              UNION ALL
              (SELECT file.stored_object_id,fact.row_number,
                      to_jsonb(fact)-ARRAY['id','dataset_version_id','source_file_id','created_at']::text[] payload
                 FROM transaction_fact fact
                 JOIN import_file file ON file.id=fact.source_file_id
                WHERE fact.dataset_version_id=previous.id
               EXCEPT ALL
               SELECT file.stored_object_id,fact.row_number,
                      to_jsonb(fact)-ARRAY['id','dataset_version_id','source_file_id','created_at']::text[] payload
                 FROM transaction_fact fact
                 JOIN import_file file ON file.id=fact.source_file_id
                WHERE fact.dataset_version_id=current.id)
            ) difference
          )
          AND NOT EXISTS (
            SELECT 1 FROM quality_acknowledgement acknowledgement
             WHERE acknowledgement.dataset_version_id=current.id
               AND acknowledgement.calculation_run_id IS NULL
               AND acknowledgement.issue_kind='HARD_INCOMPLETE'
          )
     ), inherited AS (
       INSERT INTO quality_acknowledgement(
         dataset_version_id,marketplace_policy_version_id,issue_kind,issue_code,
         actor_account_id,reason,confirmation_count
       )
       SELECT dataset_version_id,policy_id,'HARD_INCOMPLETE',
              'SOURCE_REPLAY_INHERITED_HARD_INCOMPLETE',$2,$3,confirmation_count
         FROM candidate
       RETURNING id,dataset_version_id
     )
     INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
     SELECT $2,'SOURCE_REPLAY_HARD_INCOMPLETE_ACK_INHERITED','quality_acknowledgement',inherited.id,$3,
            jsonb_build_object(
              'batchId',$1::uuid::text,'shopId',candidate.shop_id::text,
              'datasetVersionId',candidate.dataset_version_id::text,
              'predecessorVersionId',candidate.predecessor_version_id::text,
              'predecessorAcknowledgementId',candidate.predecessor_acknowledgement_id::text,
              'factIdentity','FULL_TRANSACTION_FACT_MULTISET'
            )
       FROM inherited JOIN candidate USING(dataset_version_id)
     RETURNING object_id::text acknowledgement_id`,
    [batchId, actorAccountId, INHERITED_HARD_INCOMPLETE_REASON],
  );
  return { acknowledgementIds: result.rows.map((row) => row.acknowledgement_id) };
}

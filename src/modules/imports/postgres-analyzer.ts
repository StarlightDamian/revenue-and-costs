import type { Pool } from "pg";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store.js";
import { refreshUploadPreflight } from "../uploads/partial-failure.js";
import { analyzeDelimitedPrefix, classifyInput, type MappingCandidate } from "./analyze-prefix.js";
import { analyzeXlsxStream, XLSX_IMPORT_ENCODING } from "./xlsx-stream.js";

const PREFIX_LIMIT = 512 * 1024;

export interface ImportMappingCandidate extends MappingCandidate {
  readonly report_kind: "SHIPMENT" | "TRANSACTION";
}

export async function loadImportMappingCandidates(pool: Pool): Promise<readonly ImportMappingCandidate[]> {
  const result = await pool.query<ImportMappingCandidate>(
    `SELECT DISTINCT ON (mv.field_mapping_id) mv.id, mv.definition, m.report_kind
       FROM field_mapping_version mv
       JOIN field_mapping m ON m.id = mv.field_mapping_id
      ORDER BY mv.field_mapping_id, mv.version_no DESC`,
  );
  return result.rows;
}

async function readPrefix(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = PREFIX_LIMIT - bytes;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (bytes >= PREFIX_LIMIT) break;
    }
  } finally {
    if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
  }
  return Buffer.concat(chunks, bytes);
}

export async function analyzeStoredUpload(
  pool: Pool,
  store: EncryptedObjectStore,
  fileId: string,
  mappingCandidates?: readonly ImportMappingCandidate[],
): Promise<void> {
  const source = await pool.query<{
    import_batch_id: string; upload_batch_id: string; stored_object_id: string; relative_path: string; storage_path: string;
    plaintext_sha256: string; plaintext_size: string; encryption_context: Record<string, string>;
    detected_kind: "ZIP" | "PDF" | "TEXT" | "OTHER" | null;
  }>(
    `SELECT ib.id AS import_batch_id, ib.upload_batch_id, so.id AS stored_object_id, uf.relative_path, so.storage_path,
            so.plaintext_sha256, so.plaintext_size, so.encryption_context, uf.detected_kind
       FROM upload_file uf
       JOIN import_batch ib ON ib.upload_batch_id = uf.batch_id
       JOIN stored_object so ON so.id = uf.stored_object_id
      WHERE uf.id = $1`,
    [fileId],
  );
  const file = source.rows[0];
  if (!file) throw new Error("IMPORT_SOURCE_NOT_READY");
  const existing = await pool.query<{ parse_status: string }>(
    "SELECT parse_status FROM import_file WHERE import_batch_id = $1 AND stored_object_id = $2",
    [file.import_batch_id, file.stored_object_id],
  );
  if (existing.rows[0] && existing.rows[0].parse_status !== "PENDING") return;

  const prefix = await readPrefix(store.createDecryptionStream(file.storage_path, file.encryption_context));
  const leaf = file.relative_path.replaceAll("\\", "/").split("/").at(-1) ?? file.relative_path;
  const mappings = mappingCandidates ?? await loadImportMappingCandidates(pool);
  const isXlsx = !leaf.startsWith("~$") && file.detected_kind === "OTHER" &&
    prefix[0] === 0x50 && prefix[1] === 0x4b;
  const xlsxAnalysis = isXlsx
    ? await analyzeXlsxStream(
        () => store.createDecryptionStream(file.storage_path, file.encryption_context),
        mappings
          .filter((row) => row.report_kind === "SHIPMENT" && row.definition.reportKind === "SHIPMENT")
          .map((row) => ({ id: row.id, definition: row.definition })),
      )
    : undefined;
  const classification = leaf.startsWith("~$")
    ? "TEMPORARY"
    : xlsxAnalysis?.status === "MATCHED" || xlsxAnalysis?.status === "AWAITING_MAPPING"
      ? "PARSE"
      : file.detected_kind && file.detected_kind !== "TEXT"
        ? "LIST_ONLY"
        : classifyInput(file.relative_path, prefix);
  let storedClassification: "SHIPMENT" | "TRANSACTION" | "LIST_ONLY" | "TEMPORARY" | "UNKNOWN" =
    classification === "TEMPORARY" ? "TEMPORARY" : classification === "LIST_ONLY" ? "LIST_ONLY" : "UNKNOWN";
  let parseStatus: "PARSED" | "AWAITING_MAPPING" | "EXCLUDED" = classification === "PARSE" ? "AWAITING_MAPPING" : "EXCLUDED";
  const delimitedAnalysis = !xlsxAnalysis && classification === "PARSE"
    ? analyzeDelimitedPrefix(prefix, mappings.map((row) => ({ id: row.id, definition: row.definition })))
    : undefined;
  const analysis = xlsxAnalysis ?? delimitedAnalysis;
  if (analysis?.status === "MATCHED") {
    const mapping = mappings.find((row) => row.id === analysis?.mappingVersionId);
    if (!mapping) throw new Error("MAPPING_VERSION_NOT_FOUND");
    storedClassification = mapping.report_kind;
    parseStatus = "PARSED";
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO import_file
        (import_batch_id, stored_object_id, relative_path, classification, parse_status,
         detected_encoding, detected_delimiter, header_line_number, mapping_version_id,
         sha256, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),$11)
       ON CONFLICT (import_batch_id, stored_object_id) WHERE stored_object_id IS NOT NULL DO UPDATE SET
         classification=EXCLUDED.classification, parse_status=EXCLUDED.parse_status,
         detected_encoding=EXCLUDED.detected_encoding, detected_delimiter=EXCLUDED.detected_delimiter,
         header_line_number=EXCLUDED.header_line_number, mapping_version_id=EXCLUDED.mapping_version_id`,
      [file.import_batch_id, file.stored_object_id, file.relative_path, storedClassification, parseStatus,
        xlsxAnalysis?.status === "MATCHED" ? XLSX_IMPORT_ENCODING : delimitedAnalysis?.encoding ?? null,
        delimitedAnalysis?.delimiter ?? null, analysis?.headerLineNumber ?? null,
        analysis?.mappingVersionId ?? null, file.plaintext_sha256, file.plaintext_size],
    );
    if (parseStatus === "AWAITING_MAPPING") {
      await client.query(
        `INSERT INTO import_issue (import_batch_id, severity, issue_code, safe_context)
         VALUES ($1,'WARNING','AWAITING_MAPPING',$2::jsonb)`,
        [file.import_batch_id, JSON.stringify({ relativePath: file.relative_path, reason: analysis?.reason ?? "未识别结构" })],
      );
    }
    await refreshUploadPreflight(client, file.upload_batch_id, file.import_batch_id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

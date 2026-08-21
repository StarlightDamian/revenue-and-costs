export type ReportCell = string | boolean | null;
export type ReportRow = Readonly<Record<string, ReportCell>>;

export interface ColumnDefinition {
  key: string;
  header: string;
  width: number;
  kind: "text" | "date" | "integer" | "decimal" | "status";
  /** Conservative UTF-8 projection bound used by the export volume gate. */
  maxBytes?: number;
}

export interface RowSource {
  count: bigint;
  rows(): AsyncIterable<ReportRow>;
}

export interface ReportSection {
  columns: readonly ColumnDefinition[];
  source: RowSource;
}

export interface ReportExportInput {
  diagnosticId: string;
  snapshotId: string;
  publishedAt: string;
  generatedAt: string;
  shopName: string;
  policyVersion: string;
  formulaVersion: string;
  dataVersion: string;
  mappingVersion: string;
  fxVersion: string;
  timezoneVersion: string;
  codeVersion: string;
  priceVersion: string;
  manifestSha256: string;
  costAssumptions: {
    readonly profitRate: string | null;
    readonly minimumSalesCostRate: string | null;
  };
  continentPrefixes?: readonly string[];
  /** Optional user-selected projection range; absent means the full published snapshot scope. */
  reportPeriod?: {
    readonly periodStart: string;
    readonly periodEnd: string;
  };
  /** Inclusive ISO months represented by the published snapshot. */
  reportPeriods: readonly string[];
  monthly: ReportSection;
  quarterly: ReportSection;
  annual: ReportSection;
  completeness: ReportSection;
  fees: ReportSection;
  importAudit: ReportSection;
}

export function rowsFromArray(rows: readonly ReportRow[]): RowSource {
  return {
    count: BigInt(rows.length),
    async *rows() { for (const row of rows) yield row; },
  };
}

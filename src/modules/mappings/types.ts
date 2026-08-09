export type ReportKind = "SHIPMENT" | "TRANSACTION";

export interface MappingField {
  readonly canonical: string;
  readonly sourceHeaders: readonly string[];
  readonly required: boolean;
}

export interface FieldMappingDefinition {
  readonly reportKind: ReportKind;
  readonly locale: string;
  readonly fields: readonly MappingField[];
}


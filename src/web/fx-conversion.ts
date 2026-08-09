export interface FxRateCell {
  readonly rate?: string | null;
}

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}

export function formatFxRateColumn(rows: readonly FxRateCell[]): string {
  return rows.map((row) => row.rate ?? "").join("\n");
}

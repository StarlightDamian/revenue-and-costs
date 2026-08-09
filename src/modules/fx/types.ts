export type IsoDate = string;

export type MarketDayStatus = "OPEN" | "NON_TRADING" | "UNKNOWN";

export interface RawFxQuote {
  readonly id: string;
  readonly snapshotId: string;
  readonly validDate: IsoDate;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly baseUnit: string;
  readonly rate: string;
}

/** A quote normalized to 1 unit of `currency` expressed in CNY. */
export interface NormalizedFxQuote {
  readonly id: string;
  readonly source: "OFFICIAL" | "MANUAL";
  readonly validDate: IsoDate;
  readonly currency: string;
  readonly cnyPerUnit: string;
}

export interface FxOverride {
  readonly id: string;
  readonly currency: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate;
  readonly cnyPerUnit: string;
}

export interface FxQuoteBook {
  readonly official: readonly NormalizedFxQuote[];
  readonly overrides?: readonly FxOverride[];
  marketDayStatus(date: IsoDate): MarketDayStatus;
}

export type FxConversionStatus =
  | "OK"
  | "INVALID_DATE"
  | "INVALID_CURRENCY"
  | "DATA_GAP"
  | "NO_AVAILABLE_QUOTE";

export interface FxConversion {
  readonly status: FxConversionStatus;
  readonly requestedDate: IsoDate;
  readonly hitDate?: IsoDate;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate?: string;
  readonly fallbackDays?: string;
  readonly quoteIds: readonly string[];
  readonly overrideIds: readonly string[];
  readonly reason?: string;
}

export interface BatchFxInput {
  readonly input: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
}

export interface BatchFxOutput extends FxConversion {
  readonly input: string;
}

export type PaymentProviderName = 'WECHAT' | 'ALIPAY' | 'SANDBOX';
export type PaymentEventType = 'PAID' | 'REFUND' | 'REVERSAL' | 'CHARGEBACK';

export interface VerifiedPaymentEvent {
  readonly provider: PaymentProviderName;
  readonly providerEventId: string;
  readonly eventType: PaymentEventType;
  readonly merchantId: string;
  readonly internalOrderId: string;
  readonly providerTransactionId: string;
  readonly currency: 'CNY';
  /** PAID 为实际支付分；冲正事件为渠道累计退回应付分。 */
  readonly amountCents: string;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly merchantId: string;
  verifyRawSignature(rawBody: Uint8Array, headers: Readonly<Record<string, string | undefined>>): Promise<boolean>;
  parseVerifiedEvent(rawBody: Uint8Array): VerifiedPaymentEvent;
  createOrder(input: {
    readonly internalOrderId: string;
    readonly payableAmountCents: string;
    readonly currency: 'CNY';
  }): Promise<{ readonly providerPayload: Readonly<Record<string, unknown>> }>;
}

export interface PaymentEventResult {
  readonly eventId: string;
  readonly orderId: string | null;
  readonly status: 'PROCESSED' | 'DUPLICATE' | 'RECONCILIATION_REQUIRED';
  readonly walletBalanceCents: string | null;
}

export interface PaymentRepository {
  createOrder(input: {
    readonly walletId: string;
    readonly accountId: string;
    readonly provider: PaymentProviderName;
    readonly merchantId: string;
    readonly creditAmountCents: string;
    readonly payableAmountCents: string;
    readonly discountBasisPoints: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly id: string; readonly status: string; readonly duplicate: boolean }>;
  markOrderPending(orderId: string): Promise<void>;
  applyVerifiedEvent(input: {
    readonly event: VerifiedPaymentEvent;
    readonly payloadSha256: Uint8Array;
    readonly requestId: string;
  }): Promise<PaymentEventResult>;
}

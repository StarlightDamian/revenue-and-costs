import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentEventResult, PaymentProvider, PaymentProviderName, PaymentRepository, VerifiedPaymentEvent } from './model.js';
import { quoteTopUp } from '../wallet/money.js';
import { AppError } from '../../shared/errors.js';

export class PaymentCallbackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'PaymentCallbackError';
  }
}

export class PaymentService {
  private readonly providers: ReadonlyMap<PaymentProviderName, PaymentProvider>;

  constructor(
    private readonly repository: PaymentRepository,
    providers: readonly PaymentProvider[],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  quote(creditAmountCents: string) {
    return quoteTopUp(creditAmountCents);
  }

  async createOrder(input: {
    readonly walletId: string;
    readonly accountId: string;
    readonly provider: PaymentProviderName;
    readonly creditAmountCents: string;
    readonly idempotencyKey: string;
  }): Promise<{
    readonly orderId: string;
    readonly status: string;
    readonly quote: ReturnType<typeof quoteTopUp>;
    readonly providerPayload: Readonly<Record<string, unknown>>;
    readonly duplicate: boolean;
  }> {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError('PAYMENT_PROVIDER_DISABLED', '支付渠道未启用', 503);
    const quote = quoteTopUp(input.creditAmountCents);
    const order = await this.repository.createOrder({
      walletId: input.walletId,
      accountId: input.accountId,
      provider: input.provider,
      merchantId: provider.merchantId,
      ...quote,
      idempotencyKey: input.idempotencyKey,
    });
    if (order.status === 'PAID') {
      return { orderId: order.id, status: order.status, quote, providerPayload: {}, duplicate: order.duplicate };
    }
    const created = await provider.createOrder({
      internalOrderId: order.id,
      payableAmountCents: quote.payableAmountCents,
      currency: 'CNY',
    });
    await this.repository.markOrderPending(order.id);
    return { orderId: order.id, status: 'PENDING', quote, providerPayload: created.providerPayload, duplicate: order.duplicate };
  }

  async createSandboxRecharge(input: {
    readonly walletId: string;
    readonly accountId: string;
    readonly creditAmountCents: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{
    readonly orderId: string;
    readonly status: 'PAID' | 'PENDING';
    readonly quote: ReturnType<typeof quoteTopUp>;
    readonly walletBalanceCents: string | null;
  }> {
    return this.createLocalRecharge(input, 'SANDBOX');
  }

  async createTemporaryManualRecharge(input: {
    readonly walletId: string;
    readonly accountId: string;
    readonly creditAmountCents: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{
    readonly orderId: string;
    readonly status: 'PAID' | 'PENDING';
    readonly quote: ReturnType<typeof quoteTopUp>;
    readonly walletBalanceCents: string | null;
  }> {
    return this.createLocalRecharge(input, 'TEMPORARY_MANUAL');
  }

  private async createLocalRecharge(
    input: {
      readonly walletId: string;
      readonly accountId: string;
      readonly creditAmountCents: string;
      readonly idempotencyKey: string;
      readonly requestId: string;
    },
    mode: 'SANDBOX' | 'TEMPORARY_MANUAL',
  ): Promise<{
    readonly orderId: string;
    readonly status: 'PAID' | 'PENDING';
    readonly quote: ReturnType<typeof quoteTopUp>;
    readonly walletBalanceCents: string | null;
  }> {
    const provider = this.providers.get('SANDBOX');
    if (mode === 'SANDBOX') {
      if (!(provider instanceof SandboxPaymentProvider)) {
        throw new AppError('PAYMENT_SANDBOX_DISABLED', '支付沙箱未启用', 503);
      }
    } else if (!(provider instanceof TemporaryManualPaymentProvider)) {
      throw new AppError('PAYMENT_MANUAL_DISABLED', '受控充值未启用', 503);
    }

    const created = await this.createOrder({ ...input, provider: 'SANDBOX' });
    if (created.status === 'PAID') {
      return { orderId: created.orderId, status: 'PAID', quote: created.quote, walletBalanceCents: null };
    }
    const callback = provider.paidCallback(created.orderId, created.quote.payableAmountCents);
    const settled = await this.handleRawCallback({
      provider: 'SANDBOX',
      rawBody: callback.rawBody,
      headers: callback.headers,
      requestId: input.requestId,
    });
    return {
      orderId: created.orderId,
      status: settled.status === 'PROCESSED' || settled.status === 'DUPLICATE' ? 'PAID' : 'PENDING',
      quote: created.quote,
      walletBalanceCents: settled.walletBalanceCents,
    };
  }

  async handleRawCallback(input: {
    readonly provider: PaymentProviderName;
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly requestId: string;
  }): Promise<PaymentEventResult> {
    const provider = this.providers.get(input.provider);
    if (!provider) throw new PaymentCallbackError('PROVIDER_DISABLED', '支付渠道未启用', 404);
    // 原始字节验签必须先于任何 JSON 解析。
    if (!(await provider.verifyRawSignature(input.rawBody, input.headers))) {
      throw new PaymentCallbackError('SIGNATURE_INVALID', '支付回调签名无效', 401);
    }
    let event: VerifiedPaymentEvent;
    try {
      event = provider.parseVerifiedEvent(input.rawBody);
    } catch {
      throw new PaymentCallbackError('PAYLOAD_INVALID', '支付回调格式无效');
    }
    if (event.provider !== input.provider || event.merchantId !== provider.merchantId) {
      throw new PaymentCallbackError('MERCHANT_MISMATCH', '支付商户信息不匹配');
    }
    return this.repository.applyVerifiedEvent({
      event,
      payloadSha256: createHash('sha256').update(input.rawBody).digest(),
      requestId: input.requestId,
    });
  }
}

abstract class LocalSettlementPaymentProvider implements PaymentProvider {
  readonly name = 'SANDBOX' as const;
  protected abstract readonly mode: 'SANDBOX' | 'TEMPORARY_MANUAL';

  constructor(
    readonly merchantId: string,
    private readonly signingSecret: Uint8Array,
    allowProduction: boolean,
  ) {
    if (process.env.NODE_ENV === 'production' && !allowProduction) throw new Error('生产环境禁止使用支付沙箱');
  }

  async verifyRawSignature(rawBody: Uint8Array, headers: Readonly<Record<string, string | undefined>>): Promise<boolean> {
    const signature = headers['x-sandbox-signature'];
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = createHmac('sha256', this.signingSecret).update(rawBody).digest();
    const actual = Buffer.from(signature, 'hex');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  parseVerifiedEvent(rawBody: Uint8Array): VerifiedPaymentEvent {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid callback');
    const event = parsed as Record<string, unknown>;
    const eventType = event.eventType;
    if (!['PAID', 'REFUND', 'REVERSAL', 'CHARGEBACK'].includes(String(eventType))) throw new Error('invalid event type');
    for (const key of [
      'providerEventId',
      'merchantId',
      'internalOrderId',
      'providerTransactionId',
      'amountCents',
    ]) {
      if (typeof event[key] !== 'string' || !event[key]) throw new Error(`invalid ${key}`);
    }
    if (event.currency !== 'CNY' || !/^[1-9][0-9]*$/.test(String(event.amountCents))) throw new Error('invalid amount');
    return {
      provider: 'SANDBOX',
      providerEventId: String(event.providerEventId),
      eventType: eventType as VerifiedPaymentEvent['eventType'],
      merchantId: String(event.merchantId),
      internalOrderId: String(event.internalOrderId),
      providerTransactionId: String(event.providerTransactionId),
      currency: 'CNY',
      amountCents: String(event.amountCents),
    };
  }

  async createOrder(input: {
    readonly internalOrderId: string;
    readonly payableAmountCents: string;
    readonly currency: 'CNY';
  }): Promise<{ readonly providerPayload: Readonly<Record<string, unknown>> }> {
    return {
      providerPayload: {
        ...(this.mode === 'SANDBOX' ? { sandbox: true } : { temporaryManual: true }),
        ...input,
        merchantId: this.merchantId,
      },
    };
  }

  sign(rawBody: Uint8Array): string {
    return createHmac('sha256', this.signingSecret).update(rawBody).digest('hex');
  }

  paidCallback(orderId: string, payableAmountCents: string): {
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  } {
    const prefix = this.mode === 'SANDBOX' ? 'sandbox' : 'temporary-manual';
    const rawBody = Buffer.from(
      JSON.stringify({
        providerEventId: `${prefix}-paid:${orderId}`,
        eventType: 'PAID',
        merchantId: this.merchantId,
        internalOrderId: orderId,
        providerTransactionId: `${prefix}-transaction:${orderId}`,
        currency: 'CNY',
        amountCents: payableAmountCents,
      }),
    );
    return { rawBody, headers: { 'x-sandbox-signature': this.sign(rawBody) } };
  }
}

export class SandboxPaymentProvider extends LocalSettlementPaymentProvider {
  protected readonly mode = 'SANDBOX' as const;

  constructor(merchantId: string, signingSecret: Uint8Array) {
    super(merchantId, signingSecret, false);
  }
}

/**
 * 受控试运行使用的即时到账适配器。它不代表外部支付成功，只用于用户明确批准的临时充值通道。
 * 数据库仍沿用既有 SANDBOX 渠道值，以避免伪造一个不存在的真实支付渠道。
 */
export class TemporaryManualPaymentProvider extends LocalSettlementPaymentProvider {
  protected readonly mode = 'TEMPORARY_MANUAL' as const;

  constructor(merchantId: string, signingSecret: Uint8Array) {
    super(merchantId, signingSecret, true);
  }
}

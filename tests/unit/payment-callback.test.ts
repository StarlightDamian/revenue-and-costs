import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  PaymentEventResult,
  PaymentProvider,
  PaymentRepository,
  VerifiedPaymentEvent,
} from '../../src/modules/payments/index.js';
import { PaymentCallbackError, PaymentService, SandboxPaymentProvider } from '../../src/modules/payments/index.js';

const result: PaymentEventResult = {
  eventId: 'event-db',
  orderId: 'order-1',
  status: 'PROCESSED',
  walletBalanceCents: '10000',
};

function repository(events: VerifiedPaymentEvent[]): PaymentRepository {
  return {
    async createOrder() {
      return { id: 'order-1', status: 'CREATED', duplicate: false };
    },
    async markOrderPending() {},
    async applyVerifiedEvent(input) {
      events.push(input.event);
      return result;
    },
  };
}

describe('支付回调原文边界', () => {
  it('签名无效时绝不解析 JSON 或写入仓储', async () => {
    const calls: string[] = [];
    const provider: PaymentProvider = {
      name: 'SANDBOX',
      merchantId: 'merchant',
      async verifyRawSignature() {
        calls.push('verify');
        return false;
      },
      parseVerifiedEvent() {
        calls.push('parse');
        throw new Error('不应执行');
      },
      async createOrder() {
        return { providerPayload: {} };
      },
    };
    const events: VerifiedPaymentEvent[] = [];
    const service = new PaymentService(repository(events), [provider]);
    await expect(
      service.handleRawCallback({
        provider: 'SANDBOX',
        rawBody: Buffer.from('{invalid-json'),
        headers: {},
        requestId: 'request-1',
      }),
    ).rejects.toBeInstanceOf(PaymentCallbackError);
    expect(calls).toEqual(['verify']);
    expect(events).toHaveLength(0);
  });

  it('先验原始字节签名，再解析和提交已验证事件', async () => {
    const secret = Buffer.alloc(32, 3);
    const provider = new SandboxPaymentProvider('merchant', secret);
    const raw = Buffer.from(
      JSON.stringify({
        providerEventId: 'channel-event-1',
        eventType: 'PAID',
        merchantId: 'merchant',
        internalOrderId: 'order-1',
        providerTransactionId: 'channel-transaction-1',
        currency: 'CNY',
        amountCents: '10000',
      }),
    );
    const events: VerifiedPaymentEvent[] = [];
    const service = new PaymentService(repository(events), [provider]);
    const callback = await service.handleRawCallback({
      provider: 'SANDBOX',
      rawBody: raw,
      headers: { 'x-sandbox-signature': createHmac('sha256', secret).update(raw).digest('hex') },
      requestId: 'request-1',
    });
    expect(callback).toEqual(result);
    expect(events).toHaveLength(1);
    expect(events[0]?.amountCents).toBe('10000');
  });

  it('商户号不匹配时不进入数据库事务', async () => {
    const secret = Buffer.alloc(32, 4);
    const provider = new SandboxPaymentProvider('expected-merchant', secret);
    const raw = Buffer.from(
      JSON.stringify({
        providerEventId: 'channel-event-2',
        eventType: 'PAID',
        merchantId: 'attacker-merchant',
        internalOrderId: 'order-1',
        providerTransactionId: 'channel-transaction-2',
        currency: 'CNY',
        amountCents: '10000',
      }),
    );
    const events: VerifiedPaymentEvent[] = [];
    const service = new PaymentService(repository(events), [provider]);
    await expect(
      service.handleRawCallback({
        provider: 'SANDBOX',
        rawBody: raw,
        headers: { 'x-sandbox-signature': provider.sign(raw) },
        requestId: 'request-2',
      }),
    ).rejects.toMatchObject({ code: 'MERCHANT_MISMATCH' });
    expect(events).toHaveLength(0);
  });
});

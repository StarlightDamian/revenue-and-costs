import { randomUUID } from 'node:crypto';
import type { SqlClient, TransactionRunner, TransactionSideEffects } from '../authorization/index.js';
import { cumulativeCreditReversal } from '../wallet/money.js';
import { appendWalletEntry, lockWallet } from '../wallet/service.js';
import type { PaymentEventResult, PaymentRepository, VerifiedPaymentEvent } from './model.js';
import { AppError } from '../../shared/errors.js';

interface OrderRow extends Record<string, unknown> {
  id: string;
  wallet_id: string;
  account_id: string;
  provider: string;
  merchant_id: string;
  credit_amount_cents: string;
  payable_amount_cents: string;
  currency: 'CNY';
  status: string;
  provider_transaction_id: string | null;
}

interface InboxRow extends Record<string, unknown> {
  id: string;
  payment_order_id: string | null;
  event_type: VerifiedPaymentEvent['eventType'];
  provider_transaction_id: string;
  payload_sha256: Uint8Array;
}

export class PostgresPaymentRepository implements PaymentRepository {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async createOrder(input: Parameters<PaymentRepository['createOrder']>[0]) {
    return this.transactions.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('payment-order:' || $1 || ':' || $2, 0))",
        [input.walletId, input.idempotencyKey],
      );
      const existing = await client.query<{
        id: string;
        status: string;
        provider: string;
        merchant_id: string;
        credit_amount_cents: string;
        payable_amount_cents: string;
        discount_basis_points: string;
      }>(
        `SELECT id, status, provider, merchant_id, credit_amount_cents,
                payable_amount_cents, discount_basis_points::text
           FROM payment_order WHERE wallet_id = $1 AND account_id = $2 AND idempotency_key = $3`,
        [input.walletId, input.accountId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.provider !== input.provider ||
          prior.merchant_id !== input.merchantId ||
          prior.credit_amount_cents !== input.creditAmountCents ||
          prior.payable_amount_cents !== input.payableAmountCents ||
          prior.discount_basis_points !== input.discountBasisPoints
        ) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同支付订单', 409);
        }
        return { id: prior.id, status: prior.status, duplicate: true };
      }
      const result = await client.query<{ id: string; status: string }>(
        `INSERT INTO payment_order
          (wallet_id, account_id, provider, merchant_id, credit_amount_cents, payable_amount_cents,
           discount_basis_points, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
        [
          input.walletId,
          input.accountId,
          input.provider,
          input.merchantId,
          input.creditAmountCents,
          input.payableAmountCents,
          input.discountBasisPoints,
          input.idempotencyKey,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('创建支付订单失败');
      return { id: row.id, status: row.status, duplicate: false };
    });
  }

  async markOrderPending(orderId: string): Promise<void> {
    await this.reader.query(
      `UPDATE payment_order SET status = 'PENDING', updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'CREATED'`,
      [orderId],
    );
  }

  async applyVerifiedEvent(input: {
    readonly event: VerifiedPaymentEvent;
    readonly payloadSha256: Uint8Array;
    readonly requestId: string;
  }): Promise<PaymentEventResult> {
    return this.transactions.transaction(async (client) => {
      const eventId = randomUUID();
      const inserted = await client.query<{ id: string; status: string; payment_order_id: string | null }>(
        `INSERT INTO payment_event_inbox
          (id, provider, provider_event_id, event_type, provider_transaction_id,
           payload_sha256, signature_verified)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id, status, payment_order_id`,
        [
          eventId,
          input.event.provider,
          input.event.providerEventId,
          input.event.eventType,
          input.event.providerTransactionId,
          input.payloadSha256,
        ],
      );
      if (!inserted.rows[0]) {
        const duplicate = await client.query<InboxRow>(
          `SELECT id, payment_order_id, event_type, provider_transaction_id, payload_sha256
             FROM payment_event_inbox
            WHERE provider = $1 AND provider_event_id = $2
            FOR UPDATE`,
          [input.event.provider, input.event.providerEventId],
        );
        const row = duplicate.rows[0];
        if (!row) throw new Error('支付回调幂等记录不存在');
        const sameEvent =
          row.event_type === input.event.eventType &&
          row.provider_transaction_id === input.event.providerTransactionId &&
          Buffer.from(row.payload_sha256).equals(Buffer.from(input.payloadSha256));
        if (!sameEvent) {
          const orderResult = row.payment_order_id
            ? await client.query<OrderRow>('SELECT * FROM payment_order WHERE id = $1 FOR UPDATE', [row.payment_order_id])
            : null;
          const order = orderResult?.rows[0] ?? null;
          const result = await this.requireReconciliation(
            client,
            row.id,
            order,
            'DUPLICATE_EVENT_CONTENT_MISMATCH',
            input.requestId,
          );
          await this.effects.audit(client, {
            actorAccountId: null,
            actorRoles: [],
            objectType: 'payment_event',
            objectId: row.id,
            action: 'PAYMENT_EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT',
            result: 'FAILED',
            reason: 'DUPLICATE_EVENT_CONTENT_MISMATCH',
            requestId: input.requestId,
            before: {
              eventType: row.event_type,
              providerTransactionId: row.provider_transaction_id,
              payloadSha256: Buffer.from(row.payload_sha256).toString('hex'),
            },
            after: {
              eventType: input.event.eventType,
              providerTransactionId: input.event.providerTransactionId,
              payloadSha256: Buffer.from(input.payloadSha256).toString('hex'),
            },
          });
          return result;
        }
        return {
          eventId: row.id,
          orderId: row.payment_order_id,
          status: 'DUPLICATE',
          walletBalanceCents: null,
        };
      }

      const orderResult = await client.query<OrderRow>('SELECT * FROM payment_order WHERE id = $1 FOR UPDATE', [
        input.event.internalOrderId,
      ]);
      const order = orderResult.rows[0];
      if (!order || order.provider !== input.event.provider || order.merchant_id !== input.event.merchantId) {
        return this.requireReconciliation(client, eventId, order ?? null, 'ORDER_OR_MERCHANT_MISMATCH', input.requestId);
      }
      if (order.currency !== input.event.currency || order.provider_transaction_id && order.provider_transaction_id !== input.event.providerTransactionId) {
        return this.requireReconciliation(client, eventId, order, 'TRANSACTION_OR_CURRENCY_MISMATCH', input.requestId);
      }
      const reusedTransaction = await client.query<{ id: string }>(
        `SELECT id FROM payment_order
          WHERE provider = $1 AND provider_transaction_id = $2 AND id <> $3`,
        [input.event.provider, input.event.providerTransactionId, order.id],
      );
      if (reusedTransaction.rows[0]) {
        return this.requireReconciliation(client, eventId, order, 'PROVIDER_TRANSACTION_REUSED', input.requestId);
      }
      if (input.event.eventType === 'PAID') {
        return this.applyPayment(client, eventId, order, input.event, input.requestId);
      }
      return this.applyReversal(client, eventId, order, input.event, input.requestId);
    });
  }

  private async applyPayment(
    client: SqlClient,
    eventId: string,
    order: OrderRow,
    event: VerifiedPaymentEvent,
    requestId: string,
  ): Promise<PaymentEventResult> {
    if (event.amountCents !== order.payable_amount_cents) {
      return this.requireReconciliation(client, eventId, order, 'AMOUNT_MISMATCH', requestId);
    }
    if (['PAID', 'PARTIALLY_REVERSED', 'REVERSED', 'CHARGEBACK'].includes(order.status)) {
      return this.markEventDuplicate(client, eventId, order);
    }
    const ledger = await appendWalletEntry(client, {
      walletId: order.wallet_id,
      entryType: 'TOP_UP',
      deltaCents: BigInt(order.credit_amount_cents),
      businessKey: `payment-paid:${order.id}`,
      referenceType: 'PAYMENT_ORDER',
      referenceId: order.id,
      actorAccountId: order.account_id,
      reason: null,
    });
    await client.query(
      `UPDATE payment_order
          SET status = 'PAID', provider_transaction_id = $2, paid_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1`,
      [order.id, event.providerTransactionId],
    );
    await client.query(
      `UPDATE payment_event_inbox
          SET payment_order_id = $2, status = 'PROCESSED', processed_at = clock_timestamp()
        WHERE id = $1`,
      [eventId, order.id],
    );
    await this.effects.audit(client, {
      actorAccountId: order.account_id,
      actorRoles: [],
      objectType: 'payment_order',
      objectId: order.id,
      action: 'PAYMENT_PAID',
      result: 'SUCCEEDED',
      reason: null,
      requestId,
      before: { status: order.status },
      after: { status: 'PAID', ledgerId: ledger.ledgerId },
    });
    return { eventId, orderId: order.id, status: 'PROCESSED', walletBalanceCents: ledger.wallet.balanceCents };
  }

  private async applyReversal(
    client: SqlClient,
    eventId: string,
    order: OrderRow,
    event: VerifiedPaymentEvent,
    requestId: string,
  ): Promise<PaymentEventResult> {
    if (!['PAID', 'PARTIALLY_REVERSED', 'REVERSED', 'CHARGEBACK'].includes(order.status)) {
      return this.requireReconciliation(client, eventId, order, 'REVERSAL_BEFORE_PAYMENT', requestId);
    }
    let cumulativeCredit: bigint;
    try {
      cumulativeCredit = cumulativeCreditReversal({
        originalCreditCents: order.credit_amount_cents,
        originalPayableCents: order.payable_amount_cents,
        cumulativePayableReversedCents: event.amountCents,
      });
    } catch {
      return this.requireReconciliation(client, eventId, order, 'REVERSAL_AMOUNT_INVALID', requestId);
    }
    const previous = await client.query<{
      cumulative_payable_reversed_cents: string;
      cumulative_credit_reversed_cents: string;
    }>(
      `SELECT cumulative_payable_reversed_cents, cumulative_credit_reversed_cents FROM payment_reversal
        WHERE payment_order_id = $1 ORDER BY cumulative_payable_reversed_cents DESC LIMIT 1`,
      [order.id],
    );
    const previousPayable = BigInt(previous.rows[0]?.cumulative_payable_reversed_cents ?? '0');
    const currentPayable = BigInt(event.amountCents);
    if (currentPayable < previousPayable) {
      return this.requireReconciliation(client, eventId, order, 'REVERSAL_OUT_OF_ORDER', requestId);
    }
    if (currentPayable === previousPayable) {
      return this.markEventDuplicate(client, eventId, order);
    }
    const previousCredit = BigInt(previous.rows[0]?.cumulative_credit_reversed_cents ?? '0');
    const delta = cumulativeCredit - previousCredit;
    if (delta < 0n) return this.requireReconciliation(client, eventId, order, 'REVERSAL_ROUNDING_CONFLICT', requestId);
    let ledgerId: string | null = null;
    let wallet = await lockWallet(client, order.wallet_id);
    if (delta > 0n) {
      const entry = await appendWalletEntry(client, {
        walletId: order.wallet_id,
        entryType: 'TOP_UP_REVERSAL',
        deltaCents: -delta,
        businessKey: `payment-reversal:${eventId}`,
        referenceType: 'PAYMENT_EVENT',
        referenceId: eventId,
        actorAccountId: null,
        reason: event.eventType,
        allowRestrictedDebit: true,
      });
      ledgerId = entry.ledgerId;
      wallet = entry.wallet;
    }
    await client.query(
      `INSERT INTO payment_reversal
        (payment_order_id, payment_event_id, reversal_type, cumulative_payable_reversed_cents,
         cumulative_credit_reversed_cents, ledger_delta_cents, wallet_ledger_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [order.id, eventId, event.eventType, event.amountCents, cumulativeCredit.toString(), (-delta).toString(), ledgerId],
    );
    const nextStatus =
      event.eventType === 'CHARGEBACK'
        ? 'CHARGEBACK'
        : BigInt(event.amountCents) === BigInt(order.payable_amount_cents)
          ? 'REVERSED'
          : 'PARTIALLY_REVERSED';
    await client.query('UPDATE payment_order SET status = $2, updated_at = clock_timestamp() WHERE id = $1', [
      order.id,
      nextStatus,
    ]);
    await client.query(
      `UPDATE payment_event_inbox
          SET payment_order_id = $2, status = 'PROCESSED', processed_at = clock_timestamp()
        WHERE id = $1`,
      [eventId, order.id],
    );
    await this.effects.audit(client, {
      actorAccountId: null,
      actorRoles: [],
      objectType: 'payment_order',
      objectId: order.id,
      action: `PAYMENT_${event.eventType}`,
      result: 'SUCCEEDED',
      reason: null,
      requestId,
      before: { status: order.status },
      after: { status: nextStatus, cumulativeCreditReversedCents: cumulativeCredit.toString() },
    });
    return { eventId, orderId: order.id, status: 'PROCESSED', walletBalanceCents: wallet.balanceCents };
  }

  private async markEventDuplicate(
    client: SqlClient,
    eventId: string,
    order: OrderRow,
  ): Promise<PaymentEventResult> {
    await client.query(
      `UPDATE payment_event_inbox
          SET payment_order_id = $2, status = 'DUPLICATE', processed_at = clock_timestamp()
        WHERE id = $1`,
      [eventId, order.id],
    );
    const wallet = await lockWallet(client, order.wallet_id);
    return { eventId, orderId: order.id, status: 'DUPLICATE', walletBalanceCents: wallet.balanceCents };
  }

  private async requireReconciliation(
    client: SqlClient,
    eventId: string,
    order: OrderRow | null,
    code: string,
    requestId: string,
  ): Promise<PaymentEventResult> {
    await client.query(
      `UPDATE payment_event_inbox
          SET payment_order_id = $2, status = 'RECONCILIATION_REQUIRED', failure_code = $3,
              processed_at = clock_timestamp()
        WHERE id = $1`,
      [eventId, order?.id ?? null, code],
    );
    if (order) {
      await lockWallet(client, order.wallet_id);
      await client.query(
        `UPDATE wallet_account
            SET status = CASE WHEN balance_cents < 0 THEN 'RESTRICTED_DEBT' ELSE 'RESTRICTED_RECONCILIATION' END,
                version = version + 1, updated_at = clock_timestamp()
          WHERE id = $1`,
        [order.wallet_id],
      );
      await client.query(
        `UPDATE payment_order SET status = 'RECONCILIATION_REQUIRED', updated_at = clock_timestamp() WHERE id = $1`,
        [order.id],
      );
    }
    await this.effects.audit(client, {
      actorAccountId: order?.account_id ?? null,
      actorRoles: [],
      objectType: order ? 'payment_order' : 'payment_event',
      objectId: order?.id ?? eventId,
      action: 'PAYMENT_RECONCILIATION_REQUIRED',
      result: 'FAILED',
      reason: code,
      requestId,
      before: order ? { status: order.status } : null,
      after: { status: 'RECONCILIATION_REQUIRED', eventId },
    });
    return { eventId, orderId: order?.id ?? null, status: 'RECONCILIATION_REQUIRED', walletBalanceCents: null };
  }
}

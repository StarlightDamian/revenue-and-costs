import { describe, expect, it, vi } from "vitest";
import type {
  SqlClient,
  TransactionRunner,
  TransactionSideEffects,
} from "../../src/modules/authorization/index.js";
import { PostgresPaymentRepository } from "../../src/modules/payments/postgres.js";
import type { VerifiedPaymentEvent } from "../../src/modules/payments/model.js";

const order = {
  id: "00000000-0000-4000-8000-000000000001",
  account_id: "00000000-0000-4000-8000-000000000002",
  provider: "SANDBOX",
  merchant_id: "sandbox",
  credit_amount_cents: "10000",
  payable_amount_cents: "10000",
  currency: "CNY",
  status: "PAID",
  provider_transaction_id: "provider-transaction",
};

const paid: VerifiedPaymentEvent = {
  provider: "SANDBOX",
  providerEventId: "paid-2",
  eventType: "PAID",
  merchantId: "sandbox",
  internalOrderId: order.id,
  providerTransactionId: "provider-transaction",
  currency: "CNY",
  amountCents: "10000",
};

function repository(query: ReturnType<typeof vi.fn>) {
  const client = { query } as unknown as SqlClient;
  const transactions: TransactionRunner = {
    transaction: (work) => work(client),
  };
  const effects = {
    audit: vi.fn(async () => undefined),
    outbox: vi.fn(async () => undefined),
  } satisfies TransactionSideEffects;
  return {
    effects,
    repository: new PostgresPaymentRepository(transactions, client, effects),
  };
}

describe("payment callback business duplicates", () => {
  it("marks a new PAID event duplicate without changing the order or ledger", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO payment_event_inbox")) return { rows: [{ id: "new-event" }], rowCount: 1 };
      if (sql.includes("SELECT * FROM payment_order WHERE id")) return { rows: [order], rowCount: 1 };
      if (sql.includes("WHERE provider = $1 AND provider_transaction_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE payment_event_inbox")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO wallet_account")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT * FROM wallet_account")) {
        return {
          rows: [{ account_id: order.account_id, balance_cents: "10000", status: "ACTIVE", version: "1" }],
          rowCount: 1,
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { effects, repository: paymentRepository } = repository(query);

    await expect(
      paymentRepository.applyVerifiedEvent({
        event: paid,
        payloadSha256: new Uint8Array([1]),
        requestId: "request-paid-duplicate",
      }),
    ).resolves.toMatchObject({
      orderId: order.id,
      status: "DUPLICATE",
      walletBalanceCents: "10000",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("wallet_ledger"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE payment_order SET status"))).toBe(false);
    expect(effects.audit).not.toHaveBeenCalled();
  });

  it("marks an unchanged cumulative reversal duplicate through the same terminal path", async () => {
    const reversal = {
      ...paid,
      providerEventId: "refund-2",
      eventType: "REFUND" as const,
      amountCents: "2500",
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO payment_event_inbox")) return { rows: [{ id: "new-event" }], rowCount: 1 };
      if (sql.includes("SELECT * FROM payment_order WHERE id")) {
        return { rows: [{ ...order, status: "PARTIALLY_REVERSED" }], rowCount: 1 };
      }
      if (sql.includes("WHERE provider = $1 AND provider_transaction_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM payment_reversal")) {
        return {
          rows: [{ cumulative_payable_reversed_cents: "2500", cumulative_credit_reversed_cents: "2500" }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE payment_event_inbox")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO wallet_account")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT * FROM wallet_account")) {
        return {
          rows: [{ account_id: order.account_id, balance_cents: "7500", status: "ACTIVE", version: "2" }],
          rowCount: 1,
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { effects, repository: paymentRepository } = repository(query);

    await expect(
      paymentRepository.applyVerifiedEvent({
        event: reversal,
        payloadSha256: new Uint8Array([2]),
        requestId: "request-reversal-duplicate",
      }),
    ).resolves.toMatchObject({
      orderId: order.id,
      status: "DUPLICATE",
      walletBalanceCents: "7500",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("wallet_ledger"))).toBe(false);
    expect(effects.audit).not.toHaveBeenCalled();
  });

  it("keeps exact provider-event replay distinct and does not read the wallet", async () => {
    const payload = new Uint8Array([3]);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO payment_event_inbox")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM payment_event_inbox")) {
        return {
          rows: [{
            id: "original-event",
            payment_order_id: order.id,
            event_type: paid.eventType,
            provider_transaction_id: paid.providerTransactionId,
            payload_sha256: payload,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { repository: paymentRepository } = repository(query);

    await expect(
      paymentRepository.applyVerifiedEvent({
        event: paid,
        payloadSha256: payload,
        requestId: "request-provider-replay",
      }),
    ).resolves.toEqual({
      eventId: "original-event",
      orderId: order.id,
      status: "DUPLICATE",
      walletBalanceCents: null,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("audits reconciliation state changes in the same repository transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO payment_event_inbox")) return { rows: [{ id: "new-event" }], rowCount: 1 };
      if (sql.includes("SELECT * FROM payment_order WHERE id")) {
        return { rows: [{ ...order, status: "PENDING", provider_transaction_id: null }], rowCount: 1 };
      }
      if (sql.includes("WHERE provider = $1 AND provider_transaction_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE payment_event_inbox")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO wallet_account")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT * FROM wallet_account")) {
        return {
          rows: [{ account_id: order.account_id, balance_cents: "0", status: "ACTIVE", version: "1" }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE wallet_account") || sql.includes("UPDATE payment_order SET status")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { effects, repository: paymentRepository } = repository(query);

    await expect(
      paymentRepository.applyVerifiedEvent({
        event: { ...paid, amountCents: "9999" },
        payloadSha256: new Uint8Array([4]),
        requestId: "request-reconciliation",
      }),
    ).resolves.toMatchObject({
      orderId: order.id,
      status: "RECONCILIATION_REQUIRED",
      walletBalanceCents: null,
    });
    expect(effects.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "PAYMENT_RECONCILIATION_REQUIRED",
        objectId: order.id,
        reason: "AMOUNT_MISMATCH",
        requestId: "request-reconciliation",
        result: "FAILED",
      }),
    );
  });
});

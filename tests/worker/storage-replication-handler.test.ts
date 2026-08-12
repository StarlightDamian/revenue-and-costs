import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type * as ReplicationContract from "../../src/modules/operations/replication.js";
import { replicateStoredObject, storedObjectReplicaPath } from "../../src/modules/operations/replication.js";
import { registerHandlers } from "../../src/worker/register-handlers.js";

vi.mock("../../src/modules/operations/replication.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ReplicationContract>();
  return {
    ...actual,
    replicateStoredObject: vi.fn(async () => ({
      bytes: 16n,
      sha256: "a".repeat(64),
      verifiedAt: "2026-08-10T00:00:00.000Z",
    })),
  };
});

interface ReplicationJob {
  readonly id: string;
  readonly data: { readonly objectId: string };
  readonly retryCount: number;
  readonly retryLimit: number;
}

describe("stored-object replication worker", () => {
  it("registers the durable outbox topic and uses the configured replica root", async () => {
    const callbacks = new Map<string, (jobs: readonly ReplicationJob[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: unknown) => {
        callbacks.set(name, callback as (jobs: readonly ReplicationJob[]) => Promise<unknown>);
      }),
    } as unknown as PgBoss;
    const lockClient = {
      query: vi.fn(async (sql: string) => sql.includes("pg_advisory_unlock")
        ? { rows: [{ unlocked: true }], rowCount: 1 }
        : { rows: [], rowCount: 1 }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => lockClient),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM pgboss.job")) return { rows: [{ id: "job-1" }], rowCount: 1 };
        throw new Error(`unexpected replication query: ${sql}`);
      }),
    } as unknown as Pool;
    const objectId = "11111111-1111-4111-8111-111111111111";
    const replicaRoot = "D:\\offsite-replica";

    await registerHandlers(boss, {
      pool,
      objectStore: {} as never,
      exports: {} as never,
      replication: { root: replicaRoot, targetReference: replicaRoot },
    });
    const callback = callbacks.get("storage.replicate");
    expect(callback).toBeDefined();
    await callback?.([{ id: "job-1", data: { objectId }, retryCount: 0, retryLimit: 5 }]);

    expect(boss.updateQueue).toHaveBeenCalledWith("storage.replicate", expect.objectContaining({
      notify: false,
      retryLimit: 5,
    }));
    expect(replicateStoredObject).toHaveBeenCalledWith(pool, {
      objectId,
      replicaName: "offsite-primary",
      destination: storedObjectReplicaPath(replicaRoot, objectId),
      targetKind: "OFFSITE",
      targetReference: replicaRoot,
    });
  });
});

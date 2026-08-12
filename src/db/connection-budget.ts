export const DATABASE_POOL_LIMITS = {
  // One intermediate export may hold a session advisory-lock lease while its
  // queries use the other connection. Network uploads stage before DB locks.
  api: 2,
  // A calculation job can hold its session lock, transaction, and COPY reader
  // together. Job callbacks are globally serialized inside this worker.
  worker: 3,
  cli: 1,
  queue: 1,
} as const;

export type DatabasePoolPurpose = Exclude<keyof typeof DATABASE_POOL_LIMITS, "queue">;

export const STEADY_STATE_CONNECTION_BUDGET =
  DATABASE_POOL_LIMITS.api
  + DATABASE_POOL_LIMITS.worker
  + DATABASE_POOL_LIMITS.queue;

// Googcci shares this cluster and has an independently enforced limit of 10.
// Revenue and Costs keeps one additional ordinary-role slot for release CLI
// work; emergency operator sessions use PostgreSQL's superuser-reserved slots.
export const SHARED_CLUSTER_CONNECTION_RESERVE = 10;
export const REQUIRED_USABLE_CONNECTIONS =
  STEADY_STATE_CONNECTION_BUDGET
  + SHARED_CLUSTER_CONNECTION_RESERVE
  + DATABASE_POOL_LIMITS.cli;

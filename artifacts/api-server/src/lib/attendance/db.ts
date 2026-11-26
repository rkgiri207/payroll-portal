/**
 * Minimal database interface for the attendance module. Every repository function takes a
 * `Queryable` (a pool or a transaction client), so the same code runs inside or outside a
 * transaction and can be tested with a fake. All SQL is parameterised; values are never
 * concatenated into SQL text.
 */

export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResultLike<R>>;
}

export interface TransactionClient extends Queryable {
  release(error?: Error | boolean): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<TransactionClient>;
}

/** Adapt the shared pg pool (typed loosely so this module needs no direct `pg` dependency). */
export function asPoolLike(pool: unknown): PoolLike {
  return pool as PoolLike;
}

/** Thrown inside a transaction callback to roll back and return a result instead of failing. */
export class AbortTransaction<T> extends Error {
  constructor(readonly result: T) {
    super('transaction aborted');
  }
}

/** Run `fn` in a transaction: commit on success, roll back on any error. */
export async function withTransaction<T>(pool: PoolLike, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The connection may already be unusable; the original error is what matters.
    }
    if (error instanceof AbortTransaction) return error.result as T;
    throw error;
  } finally {
    client.release();
  }
}

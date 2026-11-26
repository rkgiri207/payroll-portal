/** Test-only helper: a recording fake database. Not used by production code. */
import type { PoolLike, QueryResultLike, TransactionClient } from './db';

export interface Call { text: string; params: unknown[] }
type Result = Partial<QueryResultLike<unknown>>;
type Handler = { match: RegExp; result: Result | ((params: unknown[]) => Result) };

export class FakeDb {
  calls: Call[] = [];
  released = 0;
  private handlers: Handler[] = [];

  /** The first handler whose pattern matches the SQL text answers the query. */
  on(match: RegExp, result: Result | ((params: unknown[]) => Result)): this {
    this.handlers.push({ match, result });
    return this;
  }

  async query<R>(text: string, params: unknown[] = []): Promise<QueryResultLike<R>> {
    this.calls.push({ text, params });
    const handler = this.handlers.find(h => h.match.test(text));
    const result = handler ? (typeof handler.result === 'function' ? handler.result(params) : handler.result) : {};
    const rows = (result.rows ?? []) as R[];
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  asPool(): PoolLike {
    const client: TransactionClient = {
      query: (text, params) => this.query(text, params),
      release: () => { this.released += 1; },
    };
    return { query: (text, params) => this.query(text, params), connect: async () => client };
  }

  /** Calls whose SQL matches a pattern. */
  where(match: RegExp): Call[] {
    return this.calls.filter(c => match.test(c.text));
  }
}

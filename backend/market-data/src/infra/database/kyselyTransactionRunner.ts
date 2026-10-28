import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely, Transaction } from 'kysely';

export class KyselyTransactionRunner<TDatabase> {
  private readonly current = new AsyncLocalStorage<Transaction<TDatabase>>();

  constructor(private readonly db: Kysely<TDatabase>) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    const active = this.current.getStore();
    if (active) return work();
    return this.db.transaction().execute((trx) => this.current.run(trx, work));
  }

  executor(): Kysely<TDatabase> {
    return this.current.getStore() ?? this.db;
  }

  transaction(): Transaction<TDatabase> {
    const active = this.current.getStore();
    if (!active) throw new Error('No active transaction: call it inside TransactionRunner.run');
    return active;
  }
}

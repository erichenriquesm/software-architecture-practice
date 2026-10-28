import { sql } from 'kysely';
import type { VoidedOrders } from '../../application/contracts/voidedOrders.js';
import type { OrderId } from '../../domain/valueObjects/orderId.js';
import type { Database } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';

/** Tombstones, serialized per order with a transaction-scoped advisory lock (released at commit or rollback). */
export class KyselyVoidedOrders implements VoidedOrders {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async isVoided(orderId: OrderId): Promise<boolean> {
    await this.lock(orderId);
    const row = await this.runner.transaction().selectFrom('voided_order').select('order_id').where('order_id', '=', orderId.value).executeTakeFirst();
    return row !== undefined;
  }

  async markVoided(orderId: OrderId): Promise<void> {
    await this.lock(orderId);
    await this.runner
      .transaction()
      .insertInto('voided_order')
      .values({ order_id: orderId.value })
      .onConflict((conflict) => conflict.column('order_id').doNothing())
      .execute();
  }

  private async lock(orderId: OrderId): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${orderId.value}, 0))`.execute(this.runner.transaction());
  }
}

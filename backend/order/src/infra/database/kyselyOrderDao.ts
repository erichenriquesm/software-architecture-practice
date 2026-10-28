import type { OrderDao } from '../../application/contracts/orderDao.js';
import type { OrderView } from '../../application/dtos/orderView.js';
import type { OrderStatus } from '../../domain/valueObjects/orderStatus.js';
import type { Database } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';

const columns = [
  'order_id as orderId',
  'account_id as accountId',
  'market_id as marketId',
  'side',
  'quantity',
  'price',
  'fill_quantity as fillQuantity',
  'fill_price as fillPrice',
  'timestamp',
  'status',
  'status_reason as statusReason',
] as const;

const viewOf = (row: Omit<OrderView, 'timestamp'> & { readonly timestamp: Date }): OrderView => ({ ...row, timestamp: row.timestamp.toISOString() });

export class KyselyOrderDao implements OrderDao {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async findById(orderId: string): Promise<OrderView | undefined> {
    const row = await this.runner.executor().selectFrom('order_view').select(columns).where('order_id', '=', orderId).executeTakeFirst();
    return row ? viewOf(row) : undefined;
  }

  async listByAccount(accountId: string, status?: OrderStatus): Promise<OrderView[]> {
    let query = this.runner.executor().selectFrom('order_view').select(columns).where('account_id', '=', accountId);
    if (status) query = query.where('status', '=', status);
    const rows = await query.orderBy('timestamp', 'desc').limit(500).execute();
    return rows.map(viewOf);
  }

  async listPendingCreatedBefore(cutoff: Date): Promise<string[]> {
    const rows = await this.runner
      .executor()
      .selectFrom('order')
      .select('order_id')
      .where('reservation', '=', 'pending')
      .where('created_at', '<', cutoff)
      .orderBy('created_at')
      .limit(100)
      .execute();
    return rows.map((row) => row.order_id);
  }
}

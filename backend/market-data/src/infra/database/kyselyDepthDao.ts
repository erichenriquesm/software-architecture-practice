import type { Kysely } from 'kysely';
import type { DepthDao } from '../../application/contracts/depthDao.js';
import type { DepthLevelView, DepthView } from '../../application/dtos/depthView.js';
import type { Database } from './database.js';

interface DepthRow extends DepthLevelView {
  readonly side: string;
}

const levelsOf = (rows: readonly DepthRow[], side: string): DepthLevelView[] =>
  rows.filter((row) => row.side === side).map((row) => ({ quantity: row.quantity, price: row.price }));

export class KyselyDepthDao implements DepthDao {
  constructor(private readonly db: Kysely<Database>) {}

  /** Repeatable read: the levels and the sequence come from the same snapshot even while a new one is applied. */
  async findByPrecision(marketId: string, precision: number): Promise<DepthView> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const state = await trx.selectFrom('book_state_view').select(['sequence', 'updated_at']).where('market_id', '=', marketId).executeTakeFirst();
        const rows = await trx
          .selectFrom('depth_view')
          .select(['side', 'price', 'quantity'])
          .where('market_id', '=', marketId)
          .where('precision', '=', precision)
          .orderBy('price', 'asc')
          .execute();
        return {
          buys: levelsOf(rows, 'buy').reverse(),
          sells: levelsOf(rows, 'sell'),
          sequence: Number(state?.sequence ?? 0),
          asOf: state ? state.updated_at.toISOString() : null,
        };
      });
  }
}

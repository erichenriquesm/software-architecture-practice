import type { BalanceProjection } from '../../application/contracts/balanceProjection.js';
import type { BalanceChange } from '../../application/dtos/balanceView.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';
import type { Database } from './database.js';

export class KyselyBalanceProjection implements BalanceProjection {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async applyIfNewer(change: BalanceChange): Promise<boolean> {
    const result = await this.runner
      .executor()
      .insertInto('account_balance_view')
      .values({
        account_id: change.accountId,
        asset_id: change.assetId,
        available: change.available,
        reserved: change.reserved,
        version: change.version,
        updated_at: new Date(),
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'asset_id'])
          .doUpdateSet((excluded) => ({
            available: excluded.ref('excluded.available'),
            reserved: excluded.ref('excluded.reserved'),
            version: excluded.ref('excluded.version'),
            updated_at: excluded.ref('excluded.updated_at'),
          }))
          .where((eb) => eb('account_balance_view.version', '<', eb.ref('excluded.version'))),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }
}

import type { BalanceDao } from '../../application/contracts/balanceDao.js';
import type { WalletBalancesView } from '../../application/dtos/walletBalancesView.js';
import type { Database } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';

export class KyselyBalanceDao implements BalanceDao {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async findByAccount(accountId: string): Promise<WalletBalancesView | undefined> {
    const db = this.runner.executor();
    const wallet = await db.selectFrom('wallet').select('version').where('account_id', '=', accountId).executeTakeFirst();
    if (!wallet) return undefined;
    const balances = await db
      .selectFrom('balance')
      .select(['asset_id as assetId', 'available', 'reserved'])
      .where('account_id', '=', accountId)
      .orderBy('asset_id')
      .execute();
    return { balances, version: Number(wallet.version) };
  }
}

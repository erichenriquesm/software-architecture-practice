import type { AccountDao } from '../../application/contracts/accountDao.js';
import type { AccountView } from '../../application/dtos/accountView.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';
import type { Database } from './database.js';

export class KyselyAccountDao implements AccountDao {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async findById(accountId: string): Promise<AccountView | undefined> {
    return this.runner
      .executor()
      .selectFrom('account')
      .select(['account_id as accountId', 'name', 'email', 'document'])
      .where('account_id', '=', accountId)
      .executeTakeFirst();
  }

  async exists(accountId: string): Promise<boolean> {
    return (await this.findById(accountId)) !== undefined;
  }
}

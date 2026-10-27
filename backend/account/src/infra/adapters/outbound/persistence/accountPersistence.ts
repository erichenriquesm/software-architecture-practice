import { sql } from 'kysely';
import type { AccountDao, AccountRepository, AccountView, AssetBalance, BalanceChange, BalanceProjection } from '../../../../application/ports/accountPorts.js';
import type { Account } from '../../../../domain/account.js';
import { DuplicateEmailError } from '../../../../domain/errors.js';
import type { Email } from '../../../../domain/valueObjects.js';
import type { KyselyTransactionRunner } from '../../../platform/persistence/transactions.js';
import type { Database } from './database.js';

const uniqueViolation = '23505';
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === uniqueViolation;

export class KyselyAccountRepository implements AccountRepository {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async existsByEmail(email: Email): Promise<boolean> {
    const row = await this.runner
      .executor()
      .selectFrom('account')
      .select('account_id')
      .where(sql<string>`lower(email)`, '=', email.value)
      .executeTakeFirst();
    return row !== undefined;
  }

  async save(account: Account): Promise<void> {
    try {
      await this.runner
        .executor()
        .insertInto('account')
        .values({
          account_id: account.id.value,
          name: account.name.value,
          email: account.email.value,
          document: account.document.value,
          password_hash: account.passwordHash.value,
          created_at: account.createdAt,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateEmailError();
      throw error;
    }
  }
}

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

export class KyselyBalanceDao {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async listByAccount(accountId: string): Promise<AssetBalance[]> {
    return this.runner
      .executor()
      .selectFrom('account_balance_view')
      .select(['asset_id as assetId', 'available', 'reserved'])
      .where('account_id', '=', accountId)
      .orderBy('asset_id')
      .execute();
  }
}

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

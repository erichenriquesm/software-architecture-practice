import { Decimal } from 'decimal.js';
import { AccountNotFoundError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { AccountBalances } from '../contracts/accountBalances.js';
import type { AccountDao } from '../contracts/accountDao.js';
import type { AssetBalance } from '../dtos/balanceView.js';
import type { UseCase } from './useCase.js';
import type { AssetOutput, GetAccountOutput } from '../dtos/getAccountDto.js';

const scale = 8;

const assetOutputOf = (balance: AssetBalance): AssetOutput => ({
  assetId: balance.assetId,
  quantity: new Decimal(balance.available).plus(balance.reserved).toFixed(scale),
  available: new Decimal(balance.available).toFixed(scale),
  reserved: new Decimal(balance.reserved).toFixed(scale),
});

export class GetAccount implements UseCase<[accountId: string], GetAccountOutput> {
  constructor(
    private readonly accountDao: AccountDao,
    private readonly accountBalances: AccountBalances,
  ) {}

  async execute(rawAccountId: string): Promise<GetAccountOutput> {
    const accountId = AccountId.from(rawAccountId).value;
    const account = await this.accountDao.findById(accountId);
    if (!account) throw new AccountNotFoundError(accountId);

    const balances = await this.accountBalances.of(accountId);
    const output: GetAccountOutput = {
      ...account,
      assets: balances.balances.map(assetOutputOf),
      balancesStatus: balances.status,
    };
    return output;
  }
}

import { Decimal } from 'decimal.js';
import { AccountNotFoundError } from '../../../domain/errors.js';
import { AccountId } from '../../../domain/valueObjects.js';
import type { AccountBalances, AccountDao, AssetBalance } from '../../ports/accountPorts.js';
import type { UseCase } from '../../useCase.js';
import type { GetAccountInput } from './getAccountInput.js';
import type { AssetOutput, GetAccountOutput } from './getAccountOutput.js';

const scale = 8;

const assetOutputOf = (balance: AssetBalance): AssetOutput => ({
  assetId: balance.assetId,
  quantity: new Decimal(balance.available).plus(balance.reserved).toFixed(scale),
  available: new Decimal(balance.available).toFixed(scale),
  reserved: new Decimal(balance.reserved).toFixed(scale),
});

export class GetAccount implements UseCase<GetAccountInput, GetAccountOutput> {
  constructor(
    private readonly accountDao: AccountDao,
    private readonly accountBalances: AccountBalances,
  ) {}

  async execute(input: GetAccountInput): Promise<GetAccountOutput> {
    const accountId = AccountId.from(input.accountId).value;
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

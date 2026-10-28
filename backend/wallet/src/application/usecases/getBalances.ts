import { WalletNotFoundError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { BalanceDao } from '../contracts/balanceDao.js';
import type { WalletBalancesView } from '../dtos/walletBalancesView.js';
import type { UseCase } from './useCase.js';

export class GetBalances implements UseCase<[accountId: string], WalletBalancesView> {
  constructor(private readonly balanceDao: BalanceDao) {}

  async execute(rawAccountId: string): Promise<WalletBalancesView> {
    const accountId = AccountId.from(rawAccountId).value;
    const balances = await this.balanceDao.findByAccount(accountId);
    if (!balances) throw new WalletNotFoundError(accountId);
    return balances;
  }
}

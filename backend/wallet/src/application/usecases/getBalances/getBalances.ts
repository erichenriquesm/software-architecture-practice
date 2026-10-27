import { uuidOf } from '../../../domain/valueObjects.js';
import type { BalanceDao } from '../../ports/walletPorts.js';
import type { UseCase } from '../../useCase.js';
import type { GetBalancesInput } from './getBalancesInput.js';
import type { GetBalancesOutput } from './getBalancesOutput.js';

export class WalletNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`wallet ${accountId} not found`);
    this.name = 'WalletNotFoundError';
  }
}

export class GetBalances implements UseCase<GetBalancesInput, GetBalancesOutput> {
  constructor(private readonly balanceDao: BalanceDao) {}

  async execute(input: GetBalancesInput): Promise<GetBalancesOutput> {
    const accountId = uuidOf('accountId', input.accountId);
    const output = await this.balanceDao.balancesOf(accountId);
    if (!output) throw new WalletNotFoundError(accountId);
    return output;
  }
}

import { AccountId } from '../../../domain/valueObjects.js';
import type { AccountDao } from '../../ports/accountPorts.js';
import type { UseCase } from '../../useCase.js';
import type { AccountExistsInput } from './accountExistsInput.js';
import type { AccountExistsOutput } from './accountExistsOutput.js';

export class AccountExists implements UseCase<AccountExistsInput, AccountExistsOutput> {
  constructor(private readonly accountDao: AccountDao) {}

  async execute(input: AccountExistsInput): Promise<AccountExistsOutput> {
    const output: AccountExistsOutput = { exists: await this.accountDao.exists(AccountId.from(input.accountId).value) };
    return output;
  }
}

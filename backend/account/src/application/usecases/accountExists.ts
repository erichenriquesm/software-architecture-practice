import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { AccountDao } from '../contracts/accountDao.js';
import type { UseCase } from './useCase.js';
import type { AccountExistsInput } from '../dtos/accountExistsDto.js';
import type { AccountExistsOutput } from '../dtos/accountExistsDto.js';

export class AccountExists implements UseCase<AccountExistsInput, AccountExistsOutput> {
  constructor(private readonly accountDao: AccountDao) {}

  async execute(input: AccountExistsInput): Promise<AccountExistsOutput> {
    const output: AccountExistsOutput = { exists: await this.accountDao.exists(AccountId.from(input.accountId).value) };
    return output;
  }
}

import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { AccountDao } from '../contracts/accountDao.js';
import type { UseCase } from './useCase.js';

export class AccountExists implements UseCase<[accountId: string], boolean> {
  constructor(private readonly accountDao: AccountDao) {}

  async execute(accountId: string): Promise<boolean> {
    return this.accountDao.exists(AccountId.from(accountId).value);
  }
}

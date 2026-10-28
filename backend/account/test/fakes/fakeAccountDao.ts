import type { AccountDao } from '../../src/application/contracts/accountDao.js';
import type { AccountView } from '../../src/application/dtos/accountView.js';

export class FakeAccountDao implements AccountDao {
  constructor(private readonly account?: AccountView) {}

  async findById(id: string): Promise<AccountView | undefined> {
    return this.account?.accountId === id ? this.account : undefined;
  }

  async exists(id: string): Promise<boolean> {
    return this.account?.accountId === id;
  }
}

import type { AccountView } from '../dtos/accountView.js';

export interface AccountDao {
  findById(accountId: string): Promise<AccountView | undefined>;
  exists(accountId: string): Promise<boolean>;
}

import type { AccountBalancesResult } from '../dtos/balanceView.js';

export interface AccountBalances {
  of(accountId: string): Promise<AccountBalancesResult>;
}

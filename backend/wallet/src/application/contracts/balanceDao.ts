import type { WalletBalancesView } from '../dtos/walletBalancesView.js';

export interface BalanceDao {
  findByAccount(accountId: string): Promise<WalletBalancesView | undefined>;
}

import type { BalanceChange } from './balanceView.js';

export type ProjectWalletBalanceInput = BalanceChange;

export interface ProjectWalletBalanceOutput {
  readonly applied: boolean;
}

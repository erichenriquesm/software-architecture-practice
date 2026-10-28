import type { BalanceChange } from '../dtos/balanceView.js';

export interface BalanceProjection {
  applyIfNewer(change: BalanceChange): Promise<boolean>;
}

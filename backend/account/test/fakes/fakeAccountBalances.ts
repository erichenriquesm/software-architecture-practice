import type { AccountBalances } from '../../src/application/contracts/accountBalances.js';
import type { AccountBalancesResult } from '../../src/application/dtos/balanceView.js';

export const accountBalancesReturning = (result: AccountBalancesResult): AccountBalances => ({ of: async () => result });

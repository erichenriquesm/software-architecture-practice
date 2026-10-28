import type { BalancesStatus } from './balanceView.js';

export interface GetAccountInput {
  readonly accountId: string;
}

export interface AssetOutput {
  readonly assetId: string;
  readonly quantity: string;
  readonly available: string;
  readonly reserved: string;
}

export interface GetAccountOutput {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
  readonly document: string;
  readonly assets: readonly AssetOutput[];
  readonly balancesStatus: BalancesStatus;
}

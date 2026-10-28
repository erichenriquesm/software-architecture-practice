export interface AssetBalance {
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
}

export type BalancesStatus = 'ok' | 'live' | 'unavailable';

export interface AccountBalancesResult {
  readonly status: BalancesStatus;
  readonly balances: readonly AssetBalance[];
}

export interface BalanceChange {
  readonly accountId: string;
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: number;
}

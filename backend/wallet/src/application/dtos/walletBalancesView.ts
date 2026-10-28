export interface AssetBalanceView {
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
}

export interface WalletBalancesView {
  readonly balances: readonly AssetBalanceView[];
  readonly version: number;
}

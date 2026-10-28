/** Input of Deposit and Withdraw. */
export interface FundsMovement {
  readonly accountId: string;
  readonly assetId: string;
  readonly quantity: string;
}

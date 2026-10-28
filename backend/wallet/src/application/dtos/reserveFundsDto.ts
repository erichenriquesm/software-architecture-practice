export interface ReserveFundsInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
}

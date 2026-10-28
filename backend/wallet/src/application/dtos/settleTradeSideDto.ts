export interface SettleTradeSideInput {
  readonly tradeId: string;
  readonly orderId: string;
  readonly accountId: string;
  readonly role: 'buyer' | 'seller';
  readonly marketId: string;
  readonly quantity: string;
  readonly price: string;
}

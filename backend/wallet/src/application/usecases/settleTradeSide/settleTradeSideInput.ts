export interface SettleTradeSideInput {
  readonly tradeId: string;
  readonly marketId: string;
  readonly role: 'buyer' | 'seller';
  readonly accountId: string;
  readonly orderId: string;
  readonly quantity: string;
  readonly price: string;
}

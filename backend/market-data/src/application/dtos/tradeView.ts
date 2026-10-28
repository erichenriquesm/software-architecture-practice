export interface TradeView {
  readonly tradeId: string;
  readonly buyOrderId: string;
  readonly sellOrderId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly timestamp: string;
}

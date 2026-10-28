/** The order.accepted payload: an order with reserved funds, ready for the book. */
export interface ExecuteOrderInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly acceptedAt: string;
}

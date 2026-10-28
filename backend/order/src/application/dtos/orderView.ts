export interface OrderView {
  readonly orderId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly side: string;
  readonly quantity: string;
  readonly price: string;
  readonly fillQuantity: string;
  readonly fillPrice: string | null;
  readonly timestamp: string;
  readonly status: string;
  readonly statusReason: string | null;
}

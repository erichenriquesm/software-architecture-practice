export type OrderStatus = 'pending' | 'open' | 'partiallyFilled' | 'filled' | 'cancelling' | 'cancelled' | 'rejected' | 'expired';

export const orderStatuses: readonly OrderStatus[] = ['pending', 'open', 'partiallyFilled', 'filled', 'cancelling', 'cancelled', 'rejected', 'expired'];

export type ReservationState = 'pending' | 'reserved' | 'rejected' | 'voided';
export type VoidReason = 'EXPIRED' | 'CANCELLED';
export type RejectReason = 'INSUFFICIENT_FUNDS' | 'WALLET_NOT_FOUND';
export type RemovalReason = 'CANCELLED' | 'SELF_TRADE_PREVENTION';

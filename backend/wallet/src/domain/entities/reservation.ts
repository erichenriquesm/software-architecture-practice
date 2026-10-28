import { ReservationOverdrawnError } from '../errors.js';
import type { AssetId } from '../valueObjects/assetId.js';
import type { OrderId } from '../valueObjects/orderId.js';
import type { Price } from '../valueObjects/price.js';
import type { Quantity } from '../valueObjects/quantity.js';
import type { Side } from '../valueObjects/side.js';

export type ReservationStatus = 'open' | 'closed' | 'void';

export interface ReservationData {
  readonly orderId: OrderId;
  readonly assetId: AssetId;
  readonly side: Side;
  readonly limitPrice: Price;
  readonly remaining: Quantity;
  readonly status: ReservationStatus;
  readonly createdAt: Date;
}

/** Balance committed to one order. `remaining` is in the reserved asset (USD for a buy, BTC for a sell). */
export class Reservation {
  private constructor(private data: ReservationData) {}

  static open(orderId: OrderId, assetId: AssetId, side: Side, limitPrice: Price, amount: Quantity, now: Date): Reservation {
    return new Reservation({ orderId, assetId, side, limitPrice, remaining: amount, status: 'open', createdAt: now });
  }

  static restore(data: ReservationData): Reservation {
    return new Reservation(data);
  }

  get snapshot(): ReservationData {
    return this.data;
  }

  get assetId(): AssetId {
    return this.data.assetId;
  }

  get limitPrice(): Price {
    return this.data.limitPrice;
  }

  isOpen(): boolean {
    return this.data.status === 'open';
  }

  /** How much of the reserved asset an order quantity represents: quantity × limit for a buy, quantity for a sell. */
  amountFor(orderQuantity: Quantity): Quantity {
    if (this.data.side.isBuy()) return orderQuantity.times(this.data.limitPrice);
    return orderQuantity;
  }

  consume(amount: Quantity): void {
    if (this.data.remaining.isLessThan(amount)) throw new ReservationOverdrawnError(this.data.orderId.value);
    const remaining = this.data.remaining.minus(amount);
    this.data = { ...this.data, remaining, status: remaining.isZero() ? 'closed' : 'open' };
  }

  voidRemaining(): Quantity {
    const released = this.data.remaining;
    this.data = { ...this.data, remaining: released.minus(released), status: 'void' };
    return released;
  }
}

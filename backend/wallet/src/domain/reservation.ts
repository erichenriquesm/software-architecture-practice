import { ReservationExceededError } from './errors.js';
import type { Amount, Side } from './valueObjects.js';

export type ReservationStatus = 'open' | 'closed' | 'void';

export class Reservation {
  private constructor(
    readonly orderId: string,
    readonly assetId: string,
    readonly side: Side,
    readonly limitPrice: Amount,
    private remainingAmount: Amount,
    private currentStatus: ReservationStatus,
    readonly createdAt: Date,
  ) {}

  static open(orderId: string, assetId: string, side: Side, limitPrice: Amount, amount: Amount, now: Date): Reservation {
    return new Reservation(orderId, assetId, side, limitPrice, amount, 'open', now);
  }

  static restore(data: {
    orderId: string;
    assetId: string;
    side: Side;
    limitPrice: Amount;
    remaining: Amount;
    status: ReservationStatus;
    createdAt: Date;
  }): Reservation {
    return new Reservation(data.orderId, data.assetId, data.side, data.limitPrice, data.remaining, data.status, data.createdAt);
  }

  get remaining(): Amount {
    return this.remainingAmount;
  }

  get status(): ReservationStatus {
    return this.currentStatus;
  }

  consume(amount: Amount): void {
    if (this.remainingAmount.isLessThan(amount)) throw new ReservationExceededError(this.orderId);
    this.remainingAmount = this.remainingAmount.minus(amount);
    if (this.remainingAmount.isZero()) this.currentStatus = 'closed';
  }

  void(): Amount {
    const released = this.remainingAmount;
    this.consume(released);
    this.currentStatus = 'void';
    return released;
  }
}

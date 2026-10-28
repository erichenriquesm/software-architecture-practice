import type { DomainEvent } from '../domainEvents/domainEvent.js';
import type { OrderAccepted } from '../domainEvents/orderAccepted.js';
import type { OrderCancelRequested } from '../domainEvents/orderCancelRequested.js';
import type { OrderPlaced } from '../domainEvents/orderPlaced.js';
import type { OrderVoided } from '../domainEvents/orderVoided.js';
import { FillExceedsQuantityError, InvalidOrderDataError, InvalidOrderTransitionError } from '../errors.js';
import type { AccountId } from '../valueObjects/accountId.js';
import type { MarketFilters } from '../valueObjects/marketFilters.js';
import type { MarketId } from '../valueObjects/marketId.js';
import type { OrderId } from '../valueObjects/orderId.js';
import type { OrderStatus, RejectReason, RemovalReason, ReservationState, VoidReason } from '../valueObjects/orderStatus.js';
import type { Price } from '../valueObjects/price.js';
import { Quantity } from '../valueObjects/quantity.js';
import type { Side } from '../valueObjects/side.js';
import { AggregateRoot } from './aggregateRoot.js';

export interface OrderState {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly marketId: MarketId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly fillQuantity: Quantity;
  /** Σ quantity × price of the fills, exact: the average price is only computed for reading. */
  readonly fillValue: Quantity;
  readonly reservation: ReservationState;
  readonly voidReason: VoidReason | null;
  readonly rejectReason: RejectReason | null;
  readonly cancelRequested: boolean;
  /** How much left the book without executing; null until the matching service removes the order. */
  readonly removedQuantity: Quantity | null;
  readonly removalReason: RemovalReason | null;
  readonly createdAt: Date;
  readonly version: number;
}

export interface NewOrder {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly marketId: MarketId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
  readonly filters: MarketFilters;
  readonly now: Date;
}

type StatusRule = readonly [(state: OrderState) => boolean, OrderStatus];

const removedAll = (state: OrderState): boolean =>
  state.removedQuantity !== null && state.fillQuantity.plus(state.removedQuantity).equals(state.quantity);

/** Evaluated in this order; the status is always derived, never stored, so events may arrive in any order. */
const statusRules: readonly StatusRule[] = [
  [(state) => state.reservation === 'rejected', 'rejected'],
  [(state) => state.reservation === 'voided' && state.voidReason === 'EXPIRED', 'expired'],
  [(state) => state.reservation === 'voided', 'cancelled'],
  [(state) => state.reservation === 'pending', 'pending'],
  [(state) => state.fillQuantity.equals(state.quantity), 'filled'],
  [removedAll, 'cancelled'],
  [(state) => state.cancelRequested || state.removedQuantity !== null, 'cancelling'],
  [(state) => !state.fillQuantity.isZero(), 'partiallyFilled'],
];

const initialState = ({ filters: _filters, now, ...data }: NewOrder): OrderState => ({
  ...data,
  fillQuantity: Quantity.zero(),
  fillValue: Quantity.zero(),
  reservation: 'pending',
  voidReason: null,
  rejectReason: null,
  cancelRequested: false,
  removedQuantity: null,
  removalReason: null,
  createdAt: now,
  version: 0,
});

/**
 * A limit order as the user sees it. It is the owner of sagas S2 and S4: it leaves `pending` only once
 * (accepted, rejected, expired or cancelled), and fills and removals are accepted in any order.
 */
export class Order extends AggregateRoot<DomainEvent> {
  private constructor(private state: OrderState) {
    super();
  }

  static place(order: NewOrder): Order {
    if (order.quantity.isZero()) throw new InvalidOrderDataError('quantity', 'must be greater than zero');
    order.filters.validate(order.quantity, order.price);
    const placed = new Order(initialState(order));
    placed.recordEvent(placed.orderEvent('OrderPlaced', order.now) as OrderPlaced);
    return placed;
  }

  static restore(state: OrderState): Order {
    return new Order(state);
  }

  get snapshot(): OrderState {
    return this.state;
  }

  get nextVersion(): number {
    return this.state.version + 1;
  }

  status(): OrderStatus {
    return statusRules.find(([applies]) => applies(this.state))?.[1] ?? 'open';
  }

  /** Why a final status happened, when it is not obvious from the status alone. */
  statusReason(): string | null {
    if (this.state.reservation === 'rejected') return this.state.rejectReason;
    if (this.status() === 'expired') return 'EXPIRED';
    if (this.status() === 'cancelled' && this.state.removalReason === 'SELF_TRADE_PREVENTION') return 'SELF_TRADE_PREVENTION';
    return null;
  }

  isOwnedBy(accountId: AccountId): boolean {
    return this.state.accountId.value === accountId.value;
  }

  /** Pivot of saga S2: the reservation arrived while the order was still pending. Late events are ignored. */
  markReserved(now: Date): void {
    if (this.state.reservation !== 'pending') return;
    this.state = { ...this.state, reservation: 'reserved' };
    this.recordEvent({ ...this.orderEvent('OrderAccepted', now), acceptedAt: now } as OrderAccepted);
  }

  markRejected(reason: RejectReason): void {
    if (this.state.reservation !== 'pending') return;
    this.state = { ...this.state, reservation: 'rejected', rejectReason: reason };
  }

  /** Saga S2 timeout: only a pending order older than the timeout expires; anything else is left alone. */
  expire(now: Date, timeoutMs: number): void {
    if (this.state.reservation !== 'pending') return;
    if (now.getTime() - this.state.createdAt.getTime() <= timeoutMs) return;
    this.void('EXPIRED', now);
  }

  /** Pending: ends at once (Q7). In the book: asks the matching service to remove it. */
  requestCancel(now: Date): void {
    const status = this.status();
    if (status === 'pending') return this.void('CANCELLED', now);
    if (status !== 'open' && status !== 'partiallyFilled') {
      throw new InvalidOrderTransitionError(this.state.orderId.value, `cannot cancel an order that is ${status}`);
    }
    this.state = { ...this.state, cancelRequested: true };
    const event: OrderCancelRequested = { type: 'OrderCancelRequested', orderId: this.state.orderId.value, marketId: this.state.marketId.value, occurredAt: now };
    this.recordEvent(event);
  }

  /** Accepted even while cancelling: a fill can arrive after the cancel request. */
  applyFill(quantity: Quantity, price: Price): void {
    if (this.state.reservation !== 'reserved') {
      throw new InvalidOrderTransitionError(this.state.orderId.value, 'a fill needs an accepted order');
    }
    const fillQuantity = this.state.fillQuantity.plus(quantity);
    if (fillQuantity.isGreaterThan(this.state.quantity)) throw new FillExceedsQuantityError(this.state.orderId.value);
    this.state = { ...this.state, fillQuantity, fillValue: this.state.fillValue.plus(quantity.times(price)) };
  }

  /** The order left the book (user cancel or self-trade prevention) with `remainingQuantity` not executed. */
  markRemoved(remainingQuantity: Quantity, reason: RemovalReason): void {
    if (this.state.removedQuantity !== null) return;
    this.state = { ...this.state, removedQuantity: remainingQuantity, removalReason: reason };
  }

  /** The cancel came too late: the order was already fully executed. The status goes back to the derived one. */
  cancelRejected(): void {
    this.state = { ...this.state, cancelRequested: false };
  }

  private void(reason: VoidReason, now: Date): void {
    this.state = { ...this.state, reservation: 'voided', voidReason: reason };
    this.recordEvent({ ...this.orderEvent('OrderVoided', now), reason } as OrderVoided);
  }

  private orderEvent(type: string, now: Date) {
    return {
      type,
      orderId: this.state.orderId.value,
      accountId: this.state.accountId.value,
      marketId: this.state.marketId.value,
      side: this.state.side.value,
      quantity: this.state.quantity.toString(),
      price: this.state.price.toString(),
      occurredAt: now,
    };
  }
}

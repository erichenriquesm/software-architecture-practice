import type { AccountId } from '../valueObjects/accountId.js';
import type { OrderId } from '../valueObjects/orderId.js';
import type { Price } from '../valueObjects/price.js';
import type { Quantity } from '../valueObjects/quantity.js';
import type { Side } from '../valueObjects/side.js';

export interface BookEntryData {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly side: Side;
  readonly price: Price;
  readonly remaining: Quantity;
  /** Arrival number in the book: the lower, the older (time priority). */
  readonly priority: number;
  readonly acceptedAt: Date;
}

/** An order resting in the book: what is left of it and its place in the queue. */
export class BookEntry {
  private constructor(private data: BookEntryData) {}

  static of(data: BookEntryData): BookEntry {
    return new BookEntry(data);
  }

  get snapshot(): BookEntryData {
    return this.data;
  }

  get orderId(): OrderId {
    return this.data.orderId;
  }

  get price(): Price {
    return this.data.price;
  }

  get remaining(): Quantity {
    return this.data.remaining;
  }

  get priority(): number {
    return this.data.priority;
  }

  isFilled(): boolean {
    return this.data.remaining.isZero();
  }

  isBuy(): boolean {
    return this.data.side.isBuy();
  }

  sameAccountAs(other: BookEntry): boolean {
    return this.data.accountId.value === other.data.accountId.value;
  }

  /** A buy crosses a sell priced at or below it; a sell crosses a buy priced at or above it. */
  crosses(maker: BookEntry): boolean {
    const comparison = this.data.price.compareTo(maker.data.price);
    return this.isBuy() ? comparison >= 0 : comparison <= 0;
  }

  reduce(quantity: Quantity): void {
    this.data = { ...this.data, remaining: this.data.remaining.minus(quantity) };
  }
}

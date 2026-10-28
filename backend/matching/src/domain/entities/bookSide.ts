import type { OrderId } from '../valueObjects/orderId.js';
import type { Price } from '../valueObjects/price.js';
import { Quantity } from '../valueObjects/quantity.js';
import type { BookEntry } from './bookEntry.js';

export interface BookLevel {
  readonly price: string;
  readonly quantity: string;
}

type PriceOrder = (first: Price, second: Price) => number;

/**
 * One side of the book, always in price-time priority: bids by price descending, asks by price ascending,
 * and at the same price the oldest entry first.
 */
export class BookSide {
  private constructor(
    private readonly priceOrder: PriceOrder,
    private entries: BookEntry[],
  ) {}

  static bids(entries: readonly BookEntry[] = []): BookSide {
    return new BookSide((first, second) => second.compareTo(first), []).withAll(entries);
  }

  static asks(entries: readonly BookEntry[] = []): BookSide {
    return new BookSide((first, second) => first.compareTo(second), []).withAll(entries);
  }

  best(): BookEntry | undefined {
    return this.entries[0];
  }

  find(orderId: OrderId): BookEntry | undefined {
    return this.entries.find((entry) => entry.orderId.value === orderId.value);
  }

  insert(entry: BookEntry): void {
    this.entries = [...this.entries, entry].sort((first, second) => this.compare(first, second));
  }

  remove(orderId: OrderId): void {
    this.entries = this.entries.filter((entry) => entry.orderId.value !== orderId.value);
  }

  all(): readonly BookEntry[] {
    return this.entries;
  }

  /** Quantity aggregated per exact price, in priority order (what bookSnapshot publishes). */
  levels(): BookLevel[] {
    const totals = new Map<string, Quantity>();
    for (const entry of this.entries) totals.set(entry.price.toString(), (totals.get(entry.price.toString()) ?? Quantity.zero()).plus(entry.remaining));
    return [...totals.entries()].map(([price, quantity]) => ({ price, quantity: quantity.toString() }));
  }

  private withAll(entries: readonly BookEntry[]): BookSide {
    for (const entry of entries) this.insert(entry);
    return this;
  }

  private compare(first: BookEntry, second: BookEntry): number {
    return this.priceOrder(first.price, second.price) || first.priority - second.priority;
  }
}

import { Decimal } from 'decimal.js';
import { InvalidWalletDataError } from '../errors.js';
import type { Price } from './price.js';

const scale = 8;
const decimalText = /^\d+(\.\d+)?$/;

/** A non-negative amount of an asset, exact up to 8 decimal places. */
export class Quantity {
  private constructor(private readonly amount: Decimal) {}

  static from(value: string): Quantity {
    if (!decimalText.test(value)) throw new InvalidWalletDataError('quantity', 'must be a non-negative decimal string');
    return Quantity.of(new Decimal(value));
  }

  static zero(): Quantity {
    return new Quantity(new Decimal(0));
  }

  private static of(amount: Decimal): Quantity {
    if (amount.isNegative()) throw new InvalidWalletDataError('quantity', 'cannot be negative');
    if (amount.decimalPlaces() > scale) throw new InvalidWalletDataError('quantity', `has more than ${scale} decimal places`);
    return new Quantity(amount);
  }

  plus(other: Quantity): Quantity {
    return Quantity.of(this.amount.plus(other.amount));
  }

  minus(other: Quantity): Quantity {
    return Quantity.of(this.amount.minus(other.amount));
  }

  times(price: Price): Quantity {
    return Quantity.of(this.amount.times(price.value));
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isLessThan(other: Quantity): boolean {
    return this.amount.lessThan(other.amount);
  }

  fitsPrecision(decimalPlaces: number): boolean {
    return this.amount.decimalPlaces() <= decimalPlaces;
  }

  toString(): string {
    return this.amount.toFixed(scale);
  }
}

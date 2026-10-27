import { Decimal } from 'decimal.js';
import { InvalidWalletDataError } from './errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimalText = /^\d+(\.\d+)?$/;
export const internalScale = 8;

export const uuidOf = (field: string, value: string): string => {
  if (!uuid.test(value)) throw new InvalidWalletDataError(field, 'must be a uuid');
  return value.toLowerCase();
};

export type Side = 'buy' | 'sell';

export const sideOf = (value: string): Side => {
  if (value !== 'buy' && value !== 'sell') throw new InvalidWalletDataError('side', 'must be buy or sell');
  return value;
};

export class Amount {
  private constructor(readonly value: Decimal) {}

  static of(field: string, text: string, maxDecimals = internalScale): Amount {
    if (!decimalText.test(text)) throw new InvalidWalletDataError(field, 'must be a non-negative decimal');
    const value = new Decimal(text);
    if (value.decimalPlaces() > maxDecimals) throw new InvalidWalletDataError(field, `must have at most ${maxDecimals} decimals`);
    return new Amount(value);
  }

  static positive(field: string, text: string, maxDecimals = internalScale): Amount {
    const amount = Amount.of(field, text, maxDecimals);
    if (amount.value.isZero()) throw new InvalidWalletDataError(field, 'must be greater than zero');
    return amount;
  }

  static fromDecimal(value: Decimal): Amount {
    return new Amount(value);
  }

  static zero(): Amount {
    return new Amount(new Decimal(0));
  }

  plus(other: Amount): Amount {
    return new Amount(this.value.plus(other.value));
  }

  minus(other: Amount): Amount {
    return new Amount(this.value.minus(other.value));
  }

  times(other: Amount): Amount {
    return new Amount(this.value.times(other.value));
  }

  isLessThan(other: Amount): boolean {
    return this.value.lessThan(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  toString(): string {
    return this.value.toFixed(internalScale);
  }
}

export interface Asset {
  readonly assetId: string;
  readonly precision: number;
}

export interface Market {
  readonly marketId: string;
  readonly base: Asset;
  readonly quote: Asset;
}

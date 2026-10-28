import { InsufficientFundsError } from '../errors.js';
import type { AssetId } from './assetId.js';
import { Quantity } from './quantity.js';

/** What an account has of one asset: free to use (available) and committed to open orders (reserved). */
export class Balance {
  private constructor(
    readonly available: Quantity,
    readonly reserved: Quantity,
  ) {}

  static empty(): Balance {
    return new Balance(Quantity.zero(), Quantity.zero());
  }

  static of(available: Quantity, reserved: Quantity): Balance {
    return new Balance(available, reserved);
  }

  credit(quantity: Quantity): Balance {
    return new Balance(this.available.plus(quantity), this.reserved);
  }

  debit(quantity: Quantity, asset: AssetId): Balance {
    this.ensureAvailable(quantity, asset);
    return new Balance(this.available.minus(quantity), this.reserved);
  }

  reserve(quantity: Quantity, asset: AssetId): Balance {
    this.ensureAvailable(quantity, asset);
    return new Balance(this.available.minus(quantity), this.reserved.plus(quantity));
  }

  release(quantity: Quantity): Balance {
    return new Balance(this.available.plus(quantity), this.reserved.minus(quantity));
  }

  consumeReserved(quantity: Quantity): Balance {
    return new Balance(this.available, this.reserved.minus(quantity));
  }

  private ensureAvailable(quantity: Quantity, asset: AssetId): void {
    if (this.available.isLessThan(quantity)) throw new InsufficientFundsError(asset.value);
  }
}

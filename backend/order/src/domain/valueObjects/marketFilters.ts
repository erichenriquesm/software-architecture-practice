import { InvalidOrderDataError } from '../errors.js';
import type { Price } from './price.js';
import type { Quantity } from './quantity.js';

/** Market rules from the catalog (Q11): never round, reject what does not fit. */
export class MarketFilters {
  constructor(
    private readonly tickSize: Price,
    private readonly stepSize: Quantity,
    private readonly minQuantity: Quantity,
    private readonly minNotional: Quantity,
  ) {}

  validate(quantity: Quantity, price: Price): void {
    if (!price.isMultipleOf(this.tickSize)) throw new InvalidOrderDataError('price', `must be a multiple of the tick ${this.tickSize.toString()}`);
    if (!quantity.isMultipleOf(this.stepSize)) throw new InvalidOrderDataError('quantity', `must be a multiple of the step ${this.stepSize.toString()}`);
    if (quantity.isLessThan(this.minQuantity)) throw new InvalidOrderDataError('quantity', `must be at least ${this.minQuantity.toString()}`);
    if (quantity.times(price).isLessThan(this.minNotional)) throw new InvalidOrderDataError('price', `quantity × price must be at least ${this.minNotional.toString()}`);
  }
}

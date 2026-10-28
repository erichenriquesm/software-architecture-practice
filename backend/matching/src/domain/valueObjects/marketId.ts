import { InvalidBookDataError } from '../errors.js';
import { AssetId } from './assetId.js';

const pair = /^([A-Z]{3,5})-([A-Z]{3,5})$/;

/** BASE-QUOTE: the base asset is traded, the quote asset pays (BTC-USD). */
export class MarketId {
  private constructor(
    readonly value: string,
    readonly base: AssetId,
    readonly quote: AssetId,
  ) {}

  static from(value: string): MarketId {
    const match = pair.exec(value);
    if (!match) throw new InvalidBookDataError('marketId', 'must be BASE-QUOTE, like BTC-USD');
    return new MarketId(value, AssetId.from(String(match[1])), AssetId.from(String(match[2])));
  }
}

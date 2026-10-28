import { InvalidBookDataError } from '../errors.js';

const assetCode = /^[A-Z]{3,5}$/;

export class AssetId {
  private constructor(readonly value: string) {}

  static from(value: string): AssetId {
    if (!assetCode.test(value)) throw new InvalidBookDataError('assetId', 'must be an asset code like BTC');
    return new AssetId(value);
  }

  equals(other: AssetId): boolean {
    return this.value === other.value;
  }
}

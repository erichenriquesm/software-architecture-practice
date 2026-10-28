import type { DepthDao } from '../contracts/depthDao.js';
import type { MarketCatalog } from '../contracts/marketCatalog.js';
import type { DepthView } from '../dtos/depthView.js';
import { InvalidQueryError } from '../errors.js';
import { knownMarket } from './knownMarket.js';
import type { UseCase } from './useCase.js';

export class GetDepth implements UseCase<[marketId: string, precision?: number], DepthView> {
  constructor(
    private readonly depthDao: DepthDao,
    private readonly marketCatalog: MarketCatalog,
  ) {}

  /** Without a precision the book comes without aggregation (the market's smallest precision, the tick). */
  async execute(marketId: string, precision?: number): Promise<DepthView> {
    const range = knownMarket(this.marketCatalog, marketId);
    const chosen = precision ?? range.min;
    const outOfRange = !Number.isInteger(chosen) || chosen < range.min || chosen > range.max;
    if (outOfRange) throw new InvalidQueryError('precision', `must be an integer from ${range.min} to ${range.max}`);
    return this.depthDao.findByPrecision(marketId, chosen);
  }
}

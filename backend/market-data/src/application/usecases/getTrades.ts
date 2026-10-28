import type { MarketCatalog } from '../contracts/marketCatalog.js';
import type { TradeDao } from '../contracts/tradeDao.js';
import type { GetTradesInput } from '../dtos/getTradesDto.js';
import type { TradeView } from '../dtos/tradeView.js';
import { parseInstant } from '../calculations/marketPeriod.js';
import { InvalidQueryError } from '../errors.js';
import { knownMarket } from './knownMarket.js';
import type { UseCase } from './useCase.js';

export const defaultTradesLimit = 50;
export const maxTradesLimit = 500;

export class GetTrades implements UseCase<[input: GetTradesInput], TradeView[]> {
  constructor(
    private readonly tradeDao: TradeDao,
    private readonly marketCatalog: MarketCatalog,
  ) {}

  async execute(input: GetTradesInput): Promise<TradeView[]> {
    knownMarket(this.marketCatalog, input.marketId);
    const limit = input.limit ?? defaultTradesLimit;
    const outOfRange = !Number.isInteger(limit) || limit < 1 || limit > maxTradesLimit;
    if (outOfRange) throw new InvalidQueryError('limit', `must be an integer from 1 to ${maxTradesLimit}`);
    if (input.before === undefined) return this.tradeDao.listRecent(input.marketId, limit);
    return this.tradeDao.listRecent(input.marketId, limit, parseInstant('before', input.before));
  }
}

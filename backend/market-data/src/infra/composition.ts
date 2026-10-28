import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Clock } from '../application/contracts/clock.js';
import type { MarketCatalog } from '../application/contracts/marketCatalog.js';
import { GetDepth } from '../application/usecases/getDepth.js';
import { GetMarket } from '../application/usecases/getMarket.js';
import { GetTrades } from '../application/usecases/getTrades.js';
import { JsonMarketCatalog } from './catalog/jsonMarketCatalog.js';
import { BookProjector } from './database/bookProjector.js';
import type { Database } from './database/database.js';
import { KyselyDepthDao } from './database/kyselyDepthDao.js';
import { KyselyMarketStatsDao } from './database/kyselyMarketStatsDao.js';
import { KyselyTradeDao } from './database/kyselyTradeDao.js';
import { KyselyTransactionRunner } from './database/kyselyTransactionRunner.js';
import { PostgresProbe } from './database/postgres.js';
import type { DependencyProbe } from './http/health.js';
import { registerHealthRoutes } from './http/health.js';
import type { MarketDataRateLimits } from './http/marketRoutes.js';
import { defaultMarketDataRateLimits, marketDataErrorMappings, marketDataRateLimitGroups, registerMarketRoutes } from './http/marketRoutes.js';
import { registerErrorMapping } from './platform/http/errors/errorMapping.js';
import type { RateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from './platform/http/rateLimit/rateLimitPlugin.js';
import { SystemClock } from './system.js';

export const serviceName = 'market-data';
/** Redis key prefix: the marketData Redis user only sees marketData:* keys. */
export const rateLimitPrefix = 'marketData';

export interface MarketDataCoreDependencies {
  readonly db: Kysely<Database>;
  readonly marketCatalog?: MarketCatalog;
  readonly clock?: Clock;
}

/** The read use cases and the projectors wired to their adapters; shared by the api, the worker and the rebuild. */
export const buildMarketDataCore = (dependencies: MarketDataCoreDependencies) => {
  const marketCatalog = dependencies.marketCatalog ?? JsonMarketCatalog.load();
  const { db } = dependencies;
  return {
    runner: new KyselyTransactionRunner(db),
    bookProjector: new BookProjector(marketCatalog),
    getDepth: new GetDepth(new KyselyDepthDao(db), marketCatalog),
    getTrades: new GetTrades(new KyselyTradeDao(db), marketCatalog),
    getMarket: new GetMarket(new KyselyMarketStatsDao(db), marketCatalog, dependencies.clock ?? new SystemClock()),
  };
};

export type MarketDataCore = ReturnType<typeof buildMarketDataCore>;

export interface MarketDataApiDependencies extends MarketDataCoreDependencies {
  readonly rateLimiter: RateLimiter;
  readonly rateLimits?: MarketDataRateLimits;
  readonly extraProbes?: readonly DependencyProbe[];
  readonly trustProxy?: string[] | boolean;
  readonly logger?: boolean;
}

export const buildMarketDataApi = (dependencies: MarketDataApiDependencies): { app: FastifyInstance; core: MarketDataCore } => {
  const core = buildMarketDataCore(dependencies);
  const app = Fastify({ logger: dependencies.logger ?? false, trustProxy: dependencies.trustProxy ?? false });
  registerErrorMapping(app, marketDataErrorMappings);
  registerRateLimit(app, {
    limiter: dependencies.rateLimiter,
    groups: marketDataRateLimitGroups(dependencies.rateLimits ?? defaultMarketDataRateLimits),
  });
  registerHealthRoutes(app, serviceName, [new PostgresProbe(dependencies.db), ...(dependencies.extraProbes ?? [])]);
  registerMarketRoutes(app, core);
  return { app, core };
};

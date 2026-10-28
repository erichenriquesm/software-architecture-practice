import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvalidQueryError, MarketNotFoundError } from '../../application/errors.js';
import type { GetDepth } from '../../application/usecases/getDepth.js';
import type { GetMarket } from '../../application/usecases/getMarket.js';
import { defaultTradesLimit } from '../../application/usecases/getTrades.js';
import type { GetTrades } from '../../application/usecases/getTrades.js';
import type { ErrorMapping } from '../platform/http/errors/errorMapping.js';
import type { RateLimitGroup } from '../platform/http/rateLimit/rateLimitPlugin.js';
import type { RateLimitPolicy } from '../platform/http/rateLimit/slidingWindow.js';

type Limit = Omit<RateLimitPolicy, 'name'>;

export interface MarketDataRateLimits {
  readonly publicReadPerIp: Limit;
}

export const defaultMarketDataRateLimits: MarketDataRateLimits = {
  publicReadPerIp: { limit: 1_200, windowMs: 60_000 },
};

export const marketDataErrorMappings: readonly ErrorMapping[] = [
  { error: MarketNotFoundError, statusCode: 404, code: 'marketNotFound' },
  { error: InvalidQueryError, statusCode: 422, code: 'invalidQuery' },
];

const marketRoute = '/markets/:marketId';
const tradesRoute = '/markets/:marketId/trades';
const depthRoute = '/markets/:marketId/depth';
const publicRoutes = new Set([marketRoute, tradesRoute, depthRoute]);
const largeTradePage = 5;
const smallTradePage = 2;

/** Request weight, like Binance's REQUEST_WEIGHT: a bigger trades page costs more of the quota. */
export const publicReadCost = (request: FastifyRequest): number => {
  const route = request.routeOptions.url;
  if (route === depthRoute) return 2;
  if (route !== tradesRoute) return 1;
  const limit = Number((request.query as { limit?: unknown }).limit ?? defaultTradesLimit);
  return limit > defaultTradesLimit ? largeTradePage : smallTradePage;
};

export const marketDataRateLimitGroups = (limits: MarketDataRateLimits): readonly RateLimitGroup[] => [
  {
    name: 'publicRead',
    matches: (request) => request.method === 'GET' && publicRoutes.has(request.routeOptions.url ?? ''),
    perIp: limits.publicReadPerIp,
    costOf: publicReadCost,
  },
];

const optionalText = { type: 'string', maxLength: 40 } as const;

const depthQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { precision: { type: 'integer' } },
} as const;

const tradesQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer' }, before: optionalText },
} as const;

const marketQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { startDate: optionalText, endDate: optionalText },
} as const;

const marketParams = {
  type: 'object',
  required: ['marketId'],
  properties: { marketId: { type: 'string', maxLength: 11 } },
} as const;

export interface MarketRouteUseCases {
  readonly getDepth: GetDepth;
  readonly getTrades: GetTrades;
  readonly getMarket: GetMarket;
}

const marketIdOf = (request: FastifyRequest): string => (request.params as { marketId: string }).marketId;

export const registerMarketRoutes = (app: FastifyInstance, useCases: MarketRouteUseCases): void => {
  app.get(depthRoute, { schema: { params: marketParams, querystring: depthQuery } }, async (request) => {
    const { precision } = request.query as { precision?: number };
    return useCases.getDepth.execute(marketIdOf(request), precision);
  });

  app.get(tradesRoute, { schema: { params: marketParams, querystring: tradesQuery } }, async (request) => {
    const { limit, before } = request.query as { limit?: number; before?: string };
    return useCases.getTrades.execute({ marketId: marketIdOf(request), limit, before });
  });

  app.get(marketRoute, { schema: { params: marketParams, querystring: marketQuery } }, async (request) => {
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };
    return useCases.getMarket.execute({ marketId: marketIdOf(request), startDate, endDate });
  });
};

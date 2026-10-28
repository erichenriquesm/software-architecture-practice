import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { GetDepth } from '../../../../src/application/usecases/getDepth.js';
import { GetMarket } from '../../../../src/application/usecases/getMarket.js';
import { GetTrades } from '../../../../src/application/usecases/getTrades.js';
import { marketDataErrorMappings, marketDataRateLimitGroups, registerMarketRoutes } from '../../../../src/infra/http/marketRoutes.js';
import { registerErrorMapping } from '../../../../src/infra/platform/http/errors/errorMapping.js';
import type { RateLimitCheck, RateLimiter } from '../../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from '../../../../src/infra/platform/http/rateLimit/rateLimitPlugin.js';
import { FakeDepthDao } from '../../../fakes/fakeDepthDao.js';
import { FakeMarketCatalog } from '../../../fakes/fakeMarketCatalog.js';
import { FakeMarketStatsDao } from '../../../fakes/fakeMarketStatsDao.js';
import { FakeTradeDao } from '../../../fakes/fakeTradeDao.js';
import { fixedClock } from '../../../fakes/fixedSystem.js';

class RecordingRateLimiter implements RateLimiter {
  readonly checks: RateLimitCheck[] = [];

  async check(check: RateLimitCheck) {
    this.checks.push(check);
    return { allowed: true, remaining: check.policy.limit - check.cost, resetSeconds: 60, retryAfterSeconds: 0, policy: check.policy };
  }
}

const buildApp = () => {
  const limiter = new RecordingRateLimiter();
  const app = Fastify();
  const catalog = new FakeMarketCatalog();
  registerErrorMapping(app, marketDataErrorMappings);
  registerRateLimit(app, { limiter, groups: marketDataRateLimitGroups({ publicReadPerIp: { limit: 1_200, windowMs: 60_000 } }) });
  registerMarketRoutes(app, {
    getDepth: new GetDepth(new FakeDepthDao(), catalog),
    getTrades: new GetTrades(new FakeTradeDao(), catalog),
    getMarket: new GetMarket(new FakeMarketStatsDao(), catalog, fixedClock(new Date('2026-10-28T12:00:00Z'))),
  });
  return { app, limiter };
};

describe('Public read rate limit', () => {
  test.each([
    ['/markets/BTC-USD', 1],
    ['/markets/BTC-USD/depth', 2],
    ['/markets/BTC-USD/depth?precision=3', 2],
    ['/markets/BTC-USD/trades', 2],
    ['/markets/BTC-USD/trades?limit=50', 2],
    ['/markets/BTC-USD/trades?limit=51', 5],
  ])('Should weigh GET %s as %i, per IP, in the publicRead group', async (url, cost) => {
    // Given
    const { app, limiter } = buildApp();

    // When
    const response = await app.inject({ method: 'GET', url });

    // Then
    expect(response.statusCode).toBe(200);
    expect(limiter.checks.map((check) => [check.policy.name, check.subject, check.cost])).toEqual([['publicReadIp', 'ip:127.0.0.1', cost]]);
    expect(response.headers['ratelimit-policy']).toBe('"publicReadIp";q=1200;w=60');
  });
});

describe('Errors of the market routes', () => {
  test.each([
    ['/markets/ETH-USD', 404, 'marketNotFound'],
    ['/markets/BTC-USD/depth?precision=9', 422, 'invalidQuery'],
    ['/markets/BTC-USD/trades?before=yesterday', 422, 'invalidQuery'],
    ['/markets/BTC-USD?startDate=2026-10-28T11:00:00Z&endDate=2026-10-28T10:00:00Z', 422, 'invalidQuery'],
    ['/markets/BTC-USD/depth?precision=high', 422, 'invalidRequest'],
  ])('Should answer GET %s with %i %s', async (url, statusCode, error) => {
    // Given
    const { app } = buildApp();

    // When
    const response = await app.inject({ method: 'GET', url });

    // Then
    expect(response.statusCode).toBe(statusCode);
    expect(response.json().error).toBe(error);
  });
});

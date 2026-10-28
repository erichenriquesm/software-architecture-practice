import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RateLimitCheck } from '../../../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from '../../../../../src/infra/platform/http/rateLimit/rateLimiter.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
});

afterAll(async () => {
  redis.disconnect();
});

const checkAt = (nowMs: number, subject: string): RateLimitCheck => ({
  subject,
  policy: { name: 'publicRead', limit: 5, windowMs: 10_000 },
  cost: 1,
  nowMs,
});

describe('RedisRateLimiter', () => {
  test('Should take the same decisions as the in-memory limiter for the same sequence', async () => {
    // Given
    const prefix = `svc${randomUUID().slice(0, 8)}`;
    const onRedis = new RedisRateLimiter(redis, prefix);
    const inMemory = new InMemoryRateLimiter(prefix);
    const moments = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 9_999, 10_500, 14_000, 15_000, 19_000, 25_000];

    // When
    const redisDecisions = [];
    const memoryDecisions = [];
    for (const moment of moments) {
      redisDecisions.push((await onRedis.check(checkAt(moment, 'account:a-1'))).allowed);
      memoryDecisions.push((await inMemory.check(checkAt(moment, 'account:a-1'))).allowed);
    }

    // Then
    expect(redisDecisions).toEqual(memoryDecisions);
    expect(redisDecisions.slice(0, 6)).toEqual([true, true, true, true, true, false]);
  });

  test('Should keep limiting through the in-memory fallback when Redis is unreachable', async () => {
    // Given
    const unreachable = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null,
    }).on('error', () => undefined);
    const limiter = new FallbackRateLimiter(new RedisRateLimiter(unreachable, 'svc'), new InMemoryRateLimiter('svc'));

    // When
    const decisions = [];
    for (let index = 0; index < 6; index += 1) decisions.push((await limiter.check(checkAt(0, 'ip:9.9.9.9'))).allowed);

    // Then
    expect(decisions).toEqual([true, true, true, true, true, false]);
    unreachable.disconnect();
  });
});

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../../../support/database.js';
import { createTestDatabase } from '../../../../support/database.js';
import { registerIdempotency } from '../../../../../src/infra/platform/http/idempotency/idempotencyPlugin.js';
import { KyselyIdempotencyStore } from '../../../../../src/infra/platform/http/idempotency/idempotencyStore.js';
import type { RateLimitCheck } from '../../../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from '../../../../../src/infra/platform/http/rateLimit/rateLimiter.js';

const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
let redis: Redis;
let database: TestDatabase;

beforeAll(async () => {
  redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();
  database = await createTestDatabase();
});

afterAll(async () => {
  redis.disconnect();
  await database.destroy();
});

const checkAt = (nowMs: number, subject: string): RateLimitCheck => ({
  subject,
  policy: { name: 'orders', limit: 5, windowMs: 10_000 },
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

describe('Idempotency-Key', () => {
  const buildApp = () => {
    const app = Fastify({ logger: false });
    registerIdempotency(app, new KyselyIdempotencyStore(database.db));
    let created = 0;
    app.post('/deposit', async (request, reply) => {
      created += 1;
      return reply.status(201).send({ depositNumber: created, body: request.body });
    });
    app.post('/fails', async (_request, reply) => reply.status(503).send({ error: 'unavailable' }));
    return { app, createdCount: () => created };
  };

  test('Should replay the first response for the same key and body, without running the handler again', async () => {
    // Given
    const { app, createdCount } = buildApp();
    const request = { method: 'POST' as const, url: '/deposit', payload: { amount: '10' }, headers: { 'idempotency-key': randomUUID() } };

    // When
    const first = await app.inject(request);
    const second = await app.inject(request);

    // Then
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(createdCount()).toBe(1);
  });

  test('Should answer 422 when the same key comes with a different body', async () => {
    // Given
    const { app } = buildApp();
    const key = randomUUID();
    await app.inject({ method: 'POST', url: '/deposit', payload: { amount: '10' }, headers: { 'idempotency-key': key } });

    // When
    const reused = await app.inject({ method: 'POST', url: '/deposit', payload: { amount: '99' }, headers: { 'idempotency-key': key } });

    // Then
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toEqual({ error: 'idempotencyKeyReused' });
  });

  test('Should release the key after a 5xx so the client can retry', async () => {
    // Given
    const { app } = buildApp();
    const key = randomUUID();
    await app.inject({ method: 'POST', url: '/fails', payload: {}, headers: { 'idempotency-key': key } });

    // When
    const stored = await database.db.selectFrom('idempotency_key').selectAll().where('key', '=', key).execute();

    // Then
    expect(stored).toHaveLength(0);
  });

  test('Should keep keys for at least 24 hours', async () => {
    // Given
    const { app } = buildApp();
    const key = randomUUID();

    // When
    await app.inject({ method: 'POST', url: '/deposit', payload: { amount: '1' }, headers: { 'idempotency-key': key } });
    const stored = await database.db.selectFrom('idempotency_key').select(['created_at', 'expires_at']).where('key', '=', key).executeTakeFirstOrThrow();

    // Then
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000);
  });
});

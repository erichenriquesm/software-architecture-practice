import { Redis } from 'ioredis';
import { buildOrderApi, serviceName } from './composition.js';
import { createDatabase } from './database/postgres.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { apiPortSetting, durationSetting, postgresSettings, rateLimitSetting, redisSettings, trustedProxySubnets } from './settings.js';

const db = createDatabase(postgresSettings());
const redis = new Redis({
  ...redisSettings(),
  enableOfflineQueue: false,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
}).on('error', () => undefined);

const { app } = buildOrderApi({
  db,
  pendingTimeoutMs: durationSetting('ORDER_PENDING_TIMEOUT', '2m'),
  rateLimiter: new FallbackRateLimiter(new RedisRateLimiter(redis, serviceName), new InMemoryRateLimiter(serviceName)),
  rateLimits: {
    ordersPerIp: rateLimitSetting('RATE_LIMITS_ORDERS_PER_IP', '100/10s'),
    ordersPerAccount: rateLimitSetting('RATE_LIMITS_ORDERS_PER_ACCOUNT', '50/10s'),
    ordersPerAccountDaily: rateLimitSetting('RATE_LIMITS_ORDERS_PER_ACCOUNT_DAILY', '100000/24h'),
    privateReadPerIp: rateLimitSetting('RATE_LIMITS_PRIVATE_READ_PER_IP', '600/1m'),
    privateReadPerAccount: rateLimitSetting('RATE_LIMITS_PRIVATE_READ_PER_ACCOUNT', '300/1m'),
  },
  trustProxy: trustedProxySubnets(),
  logger: true,
});

const shutdown = async (): Promise<void> => {
  await app.close();
  redis.disconnect();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: apiPortSetting() });

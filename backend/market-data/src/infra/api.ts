import { Redis } from 'ioredis';
import { buildMarketDataApi, rateLimitPrefix } from './composition.js';
import { createDatabase } from './database/postgres.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { apiPortSetting, postgresSettings, rateLimitSetting, redisSettings, trustedProxySubnets } from './settings.js';

const db = createDatabase(postgresSettings());
const redis = new Redis({
  ...redisSettings(),
  enableOfflineQueue: false,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
}).on('error', () => undefined);

const { app } = buildMarketDataApi({
  db,
  rateLimiter: new FallbackRateLimiter(new RedisRateLimiter(redis, rateLimitPrefix), new InMemoryRateLimiter(rateLimitPrefix)),
  rateLimits: { publicReadPerIp: rateLimitSetting('RATE_LIMITS_PUBLIC_READ_PER_IP', '1200/1m') },
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

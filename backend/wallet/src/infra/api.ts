import { Redis } from 'ioredis';
import { buildWalletApi, serviceName } from './composition.js';
import { createDatabase } from './database/postgres.js';
import { GrpcAccountGateway } from './grpc/account/grpcAccountGateway.js';
import { startWalletGrpcServer } from './grpc/walletGrpcServer.js';
import { requiredEnv } from './platform/config/env.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import {
  apiPortSetting,
  grpcAllowedCallersSetting,
  grpcIdentitySetting,
  grpcPortSetting,
  postgresSettings,
  rateLimitSetting,
  redisSettings,
  trustedProxySubnets,
} from './settings.js';

const db = createDatabase(postgresSettings());
const redis = new Redis({
  ...redisSettings(),
  enableOfflineQueue: false,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
}).on('error', () => undefined);

const accountGateway = new GrpcAccountGateway({ address: requiredEnv('ACCOUNT_GRPC_ADDR'), identity: grpcIdentitySetting() });

const { app, core } = buildWalletApi({
  db,
  accountGateway,
  rateLimiter: new FallbackRateLimiter(new RedisRateLimiter(redis, serviceName), new InMemoryRateLimiter(serviceName)),
  rateLimits: {
    movementPerIp: rateLimitSetting('RATE_LIMITS_MOVEMENT_PER_IP', '30/1m'),
    movementPerAccount: rateLimitSetting('RATE_LIMITS_MOVEMENT_PER_ACCOUNT', '10/1m'),
  },
  trustProxy: trustedProxySubnets(),
  logger: true,
});

const grpcServer = await startWalletGrpcServer({
  getBalances: core.getBalances,
  allowedCallers: grpcAllowedCallersSetting(),
  address: `0.0.0.0:${grpcPortSetting()}`,
  onDenied: (deniedCall) => app.log.warn({ deniedCall }, 'grpc call denied'),
});

const shutdown = async (): Promise<void> => {
  grpcServer.server.forceShutdown();
  await app.close();
  accountGateway.close();
  redis.disconnect();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: apiPortSetting() });

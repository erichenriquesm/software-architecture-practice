import { Redis } from 'ioredis';
import { Argon2PasswordHasher } from '../adapters/outbound/crypto/argon2PasswordHasher.js';
import { GrpcWalletGateway } from '../adapters/outbound/gateways/wallet/grpcWalletGateway.js';
import { createDatabase } from '../adapters/outbound/persistence/postgres.js';
import { startAccountGrpcServer } from '../adapters/inbound/grpc/accountGrpcServer.js';
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from '../platform/http/rateLimit/rateLimiter.js';
import { clientCredentials, serverCredentials, tlsFilesFromEnv } from '../platform/security/grpcCredentials.js';
import { buildAccountCore, buildAccountApi } from './composition.js';
import { grpcPortSetting, httpPortSetting, postgresSettings, redisSettings, trustedProxySubnets } from './settings.js';
import { requiredEnv } from '../platform/security/secrets.js';

const keyPrefix = 'account';
const db = createDatabase(postgresSettings());
const redis = new Redis({
  ...redisSettings(),
  port: 6379,
  enableOfflineQueue: false,
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
}).on('error', () => undefined);

const tls = tlsFilesFromEnv();
const wallet = new GrpcWalletGateway({ address: requiredEnv('WALLET_GRPC_ADDR'), credentials: clientCredentials(tls) });

const app = buildAccountApi({
  db,
  rateLimiter: new FallbackRateLimiter(new RedisRateLimiter(redis, keyPrefix), new InMemoryRateLimiter(keyPrefix)),
  wallet,
  passwordHasher: new Argon2PasswordHasher(),
  trustProxy: trustedProxySubnets(),
  logger: true,
});

const grpcServer = await startAccountGrpcServer({
  accountExists: buildAccountCore(db).accountExists,
  credentials: serverCredentials(tls),
  address: `0.0.0.0:${grpcPortSetting()}`,
  onDenied: (deniedCall) => app.log.warn({ deniedCall }, 'grpc call denied by allowlist'),
});

const shutdown = async (): Promise<void> => {
  grpcServer.server.forceShutdown();
  await app.close();
  wallet.close();
  redis.disconnect();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: httpPortSetting() });

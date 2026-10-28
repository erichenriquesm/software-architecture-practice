import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AccountBalances } from '../application/contracts/accountBalances.js';
import type { Clock } from '../application/contracts/clock.js';
import type { IdGenerator } from '../application/contracts/idGenerator.js';
import type { PasswordHasher } from '../application/contracts/passwordHasher.js';
import { AccountExists } from '../application/usecases/accountExists.js';
import { GetAccount } from '../application/usecases/getAccount.js';
import { ProjectWalletBalance } from '../application/usecases/projectWalletBalance.js';
import { Signup } from '../application/usecases/signup.js';
import type { Database } from './database/database.js';
import { KyselyAccountDao } from './database/kyselyAccountDao.js';
import { KyselyAccountRepository } from './database/kyselyAccountRepository.js';
import { KyselyBalanceDao } from './database/kyselyBalanceDao.js';
import { KyselyBalanceProjection } from './database/kyselyBalanceProjection.js';
import { KyselyTransactionRunner } from './database/kyselyTransactionRunner.js';
import { PostgresProbe } from './database/postgres.js';
import type { LiveBalancesSource } from './grpc/wallet/balancesFallbackChain.js';
import { BalancesFallbackChain } from './grpc/wallet/balancesFallbackChain.js';
import type { AccountRateLimits } from './http/accountRoutes.js';
import { accountErrorMappings, accountRateLimitGroups, defaultAccountRateLimits, registerAccountRoutes } from './http/accountRoutes.js';
import type { DependencyProbe } from './http/health.js';
import { registerHealthRoutes } from './http/health.js';
import { registerAccountIntegrationEvents } from './messaging/accountIntegrationEvents.js';
import { InProcessDomainEventDispatcher } from './platform/events/inProcessDomainEventDispatcher.js';
import { registerErrorMapping } from './platform/http/errors/errorMapping.js';
import { registerIdempotency } from './platform/http/idempotency/idempotencyPlugin.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import type { RateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from './platform/http/rateLimit/rateLimitPlugin.js';
import { SystemClock, UuidV7Generator } from './system.js';

export const serviceName = 'account';

export interface AccountApiDependencies {
  readonly db: Kysely<Database>;
  readonly rateLimiter: RateLimiter;
  readonly wallet: LiveBalancesSource;
  readonly passwordHasher: PasswordHasher;
  readonly rateLimits?: AccountRateLimits;
  readonly extraProbes?: readonly DependencyProbe[];
  readonly idGenerator?: IdGenerator;
  readonly clock?: Clock;
  readonly trustProxy?: string[] | boolean;
  readonly logger?: boolean;
}

export const buildAccountCore = (db: Kysely<Database>) => {
  const runner = new KyselyTransactionRunner(db);
  const dispatcher = new InProcessDomainEventDispatcher();
  registerAccountIntegrationEvents(dispatcher, runner);
  const accountDao = new KyselyAccountDao(runner);
  return {
    runner,
    dispatcher,
    accountDao,
    balanceDao: new KyselyBalanceDao(runner),
    accountRepository: new KyselyAccountRepository(runner),
    accountExists: new AccountExists(accountDao),
    projectWalletBalance: new ProjectWalletBalance(new KyselyBalanceProjection(runner)),
  };
};

export const buildAccountApi = (dependencies: AccountApiDependencies): FastifyInstance => {
  const core = buildAccountCore(dependencies.db);
  const accountBalances: AccountBalances = new BalancesFallbackChain(core.balanceDao, dependencies.wallet);
  const signup = new Signup(
    core.accountRepository,
    dependencies.passwordHasher,
    core.runner,
    core.dispatcher,
    dependencies.idGenerator ?? new UuidV7Generator(),
    dependencies.clock ?? new SystemClock(),
  );
  const getAccount = new GetAccount(core.accountDao, accountBalances);

  const app = Fastify({ logger: dependencies.logger ?? false, trustProxy: dependencies.trustProxy ?? false });
  registerErrorMapping(app, accountErrorMappings);
  registerRateLimit(app, {
    limiter: dependencies.rateLimiter,
    groups: accountRateLimitGroups(dependencies.rateLimits ?? defaultAccountRateLimits),
  });
  registerIdempotency(app, new KyselyIdempotencyStore(dependencies.db));
  registerHealthRoutes(app, serviceName, [new PostgresProbe(dependencies.db), ...(dependencies.extraProbes ?? [])]);
  registerAccountRoutes(app, { signup, getAccount });
  return app;
};

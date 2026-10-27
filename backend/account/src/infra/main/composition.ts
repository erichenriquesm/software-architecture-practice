import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AccountBalances, PasswordHasher } from '../../application/ports/accountPorts.js';
import type { Clock, IdGenerator } from '../../application/ports/system.js';
import { AccountExists } from '../../application/usecases/accountExists/accountExists.js';
import { GetAccount } from '../../application/usecases/getAccount/getAccount.js';
import { GetServiceHealth } from '../../application/usecases/getServiceHealth/getServiceHealth.js';
import { ProjectWalletBalance } from '../../application/usecases/projectWalletBalance/projectWalletBalance.js';
import { Signup } from '../../application/usecases/signup/signup.js';
import type { DependencyProbe } from '../../application/ports/dependencyProbe.js';
import { ServiceName } from '../../domain/serviceName.js';
import { accountErrorMappings, accountRateLimitGroups, registerAccountRoutes } from '../adapters/inbound/http/accountRoutes.js';
import { registerHealthRoutes } from '../adapters/inbound/http/healthRoutes.js';
import { registerAccountIntegrationEvents } from '../adapters/outbound/messaging/accountIntegrationEvents.js';
import {
  KyselyAccountDao,
  KyselyAccountRepository,
  KyselyBalanceDao,
  KyselyBalanceProjection,
} from '../adapters/outbound/persistence/accountPersistence.js';
import type { Database } from '../adapters/outbound/persistence/database.js';
import { PostgresProbe } from '../adapters/outbound/persistence/postgres.js';
import { SystemClock, UuidV7Generator } from '../adapters/outbound/system/system.js';
import type { LiveBalancesSource } from '../adapters/outbound/gateways/wallet/balancesFallbackChain.js';
import { BalancesFallbackChain } from '../adapters/outbound/gateways/wallet/balancesFallbackChain.js';
import { InProcessDomainEventDispatcher } from '../platform/events/inProcessDomainEventDispatcher.js';
import { registerErrorMapping } from '../platform/http/errors/errorMapping.js';
import { registerIdempotency } from '../platform/http/idempotency/idempotencyPlugin.js';
import { KyselyIdempotencyStore } from '../platform/http/idempotency/idempotencyStore.js';
import type { RateLimiter } from '../platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from '../platform/http/rateLimit/rateLimitPlugin.js';
import { KyselyTransactionRunner } from '../platform/persistence/transactions.js';

export interface AccountApiDependencies {
  readonly db: Kysely<Database>;
  readonly rateLimiter: RateLimiter;
  readonly wallet: LiveBalancesSource;
  readonly passwordHasher: PasswordHasher;
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
  const health = new GetServiceHealth(ServiceName.from('account'), [
    new PostgresProbe(dependencies.db),
    ...(dependencies.extraProbes ?? []),
  ]);

  const app = Fastify({ logger: dependencies.logger ?? false, trustProxy: dependencies.trustProxy ?? false });
  registerErrorMapping(app, accountErrorMappings);
  registerRateLimit(app, { limiter: dependencies.rateLimiter, groups: accountRateLimitGroups });
  registerIdempotency(app, new KyselyIdempotencyStore(dependencies.db));
  registerHealthRoutes(app, health);
  registerAccountRoutes(app, { signup, getAccount });
  return app;
};

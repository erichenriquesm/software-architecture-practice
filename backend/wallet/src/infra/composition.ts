import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AccountGateway } from '../application/contracts/accountGateway.js';
import type { Clock } from '../application/contracts/clock.js';
import type { MarketCatalog } from '../application/contracts/marketCatalog.js';
import { CompensateReservation } from '../application/usecases/compensateReservation.js';
import { Deposit } from '../application/usecases/deposit.js';
import { GetBalances } from '../application/usecases/getBalances.js';
import { OpenWallet } from '../application/usecases/openWallet.js';
import { ReleaseReservation } from '../application/usecases/releaseReservation.js';
import { ReserveFunds } from '../application/usecases/reserveFunds.js';
import { SettleTradeSide } from '../application/usecases/settleTradeSide.js';
import { WalletStore } from '../application/usecases/walletStore.js';
import { Withdraw } from '../application/usecases/withdraw.js';
import { JsonMarketCatalog } from './catalog/jsonMarketCatalog.js';
import type { Database } from './database/database.js';
import { KyselyBalanceDao } from './database/kyselyBalanceDao.js';
import { KyselyTransactionRunner } from './database/kyselyTransactionRunner.js';
import { KyselyVoidedOrders } from './database/kyselyVoidedOrders.js';
import { KyselyWalletRepository } from './database/kyselyWalletRepository.js';
import { PostgresProbe } from './database/postgres.js';
import type { DependencyProbe } from './http/health.js';
import { registerHealthRoutes } from './http/health.js';
import type { WalletRateLimits } from './http/walletRoutes.js';
import { defaultWalletRateLimits, registerWalletRoutes, walletErrorMappings, walletRateLimitGroups } from './http/walletRoutes.js';
import { registerWalletIntegrationEvents } from './messaging/walletIntegrationEvents.js';
import { InProcessDomainEventDispatcher } from './platform/events/inProcessDomainEventDispatcher.js';
import { registerErrorMapping } from './platform/http/errors/errorMapping.js';
import { registerIdempotency } from './platform/http/idempotency/idempotencyPlugin.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import type { RateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from './platform/http/rateLimit/rateLimitPlugin.js';
import { SystemClock } from './system.js';

export const serviceName = 'wallet';

export interface WalletCoreDependencies {
  readonly db: Kysely<Database>;
  readonly accountGateway: AccountGateway;
  readonly marketCatalog?: MarketCatalog;
  readonly clock?: Clock;
}

/** Every use case wired to its adapters; shared by the api and the worker processes. */
export const buildWalletCore = (dependencies: WalletCoreDependencies) => {
  const runner = new KyselyTransactionRunner(dependencies.db);
  const dispatcher = new InProcessDomainEventDispatcher();
  registerWalletIntegrationEvents(dispatcher, runner);
  const walletRepository = new KyselyWalletRepository(runner);
  const voidedOrders = new KyselyVoidedOrders(runner);
  const marketCatalog = dependencies.marketCatalog ?? JsonMarketCatalog.load();
  const clock = dependencies.clock ?? new SystemClock();
  const walletStore = new WalletStore(walletRepository, dependencies.accountGateway, runner, dispatcher);
  return {
    runner,
    walletRepository,
    openWallet: new OpenWallet(walletRepository, walletStore),
    deposit: new Deposit(walletStore, marketCatalog, clock),
    withdraw: new Withdraw(walletStore, marketCatalog, clock),
    reserveFunds: new ReserveFunds(walletStore, voidedOrders, marketCatalog, runner, dispatcher, clock),
    settleTradeSide: new SettleTradeSide(walletStore, clock),
    releaseReservation: new ReleaseReservation(walletStore, clock),
    compensateReservation: new CompensateReservation(walletRepository, walletStore, voidedOrders, runner, clock),
    getBalances: new GetBalances(new KyselyBalanceDao(runner)),
  };
};

export type WalletCore = ReturnType<typeof buildWalletCore>;

export interface WalletApiDependencies extends WalletCoreDependencies {
  readonly rateLimiter: RateLimiter;
  readonly rateLimits?: WalletRateLimits;
  readonly extraProbes?: readonly DependencyProbe[];
  readonly trustProxy?: string[] | boolean;
  readonly logger?: boolean;
}

export const buildWalletApi = (dependencies: WalletApiDependencies): { app: FastifyInstance; core: WalletCore } => {
  const core = buildWalletCore(dependencies);
  const app = Fastify({ logger: dependencies.logger ?? false, trustProxy: dependencies.trustProxy ?? false });
  registerErrorMapping(app, walletErrorMappings);
  registerRateLimit(app, {
    limiter: dependencies.rateLimiter,
    groups: walletRateLimitGroups(dependencies.rateLimits ?? defaultWalletRateLimits),
  });
  registerIdempotency(app, new KyselyIdempotencyStore(dependencies.db));
  registerHealthRoutes(app, serviceName, [new PostgresProbe(dependencies.db), ...(dependencies.extraProbes ?? [])]);
  registerWalletRoutes(app, { deposit: core.deposit, withdraw: core.withdraw });
  return { app, core };
};

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Clock } from '../application/contracts/clock.js';
import type { IdGenerator } from '../application/contracts/idGenerator.js';
import type { MarketCatalog } from '../application/contracts/marketCatalog.js';
import { AcceptOrder } from '../application/usecases/acceptOrder.js';
import { ApplyFill } from '../application/usecases/applyFill.js';
import { CancelOrder } from '../application/usecases/cancelOrder.js';
import { ExpireOrder } from '../application/usecases/expireOrder.js';
import { GetOrder } from '../application/usecases/getOrder.js';
import { GetOrders } from '../application/usecases/getOrders.js';
import { OrderStore } from '../application/usecases/orderStore.js';
import { PlaceOrder } from '../application/usecases/placeOrder.js';
import { RegisterRemoval } from '../application/usecases/registerRemoval.js';
import { RejectOrder } from '../application/usecases/rejectOrder.js';
import { RevertCancelRequest } from '../application/usecases/revertCancelRequest.js';
import { JsonMarketCatalog } from './catalog/jsonMarketCatalog.js';
import type { Database } from './database/database.js';
import { KyselyOrderDao } from './database/kyselyOrderDao.js';
import { KyselyOrderRepository } from './database/kyselyOrderRepository.js';
import { KyselyTransactionRunner } from './database/kyselyTransactionRunner.js';
import { PostgresProbe } from './database/postgres.js';
import type { DependencyProbe } from './http/health.js';
import { registerHealthRoutes } from './http/health.js';
import type { OrderRateLimits } from './http/orderRoutes.js';
import { defaultOrderRateLimits, orderErrorMappings, orderRateLimitGroups, registerOrderRoutes } from './http/orderRoutes.js';
import { registerOrderIntegrationEvents } from './messaging/orderIntegrationEvents.js';
import { InProcessDomainEventDispatcher } from './platform/events/inProcessDomainEventDispatcher.js';
import { registerErrorMapping } from './platform/http/errors/errorMapping.js';
import { registerIdempotency } from './platform/http/idempotency/idempotencyPlugin.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import type { RateLimiter } from './platform/http/rateLimit/rateLimiter.js';
import { registerRateLimit } from './platform/http/rateLimit/rateLimitPlugin.js';
import { SystemClock, UuidV7Generator } from './system.js';

export const serviceName = 'order';
const twoMinutes = 2 * 60 * 1_000;

export interface OrderCoreDependencies {
  readonly db: Kysely<Database>;
  readonly marketCatalog?: MarketCatalog;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly pendingTimeoutMs?: number;
}

/** Every use case wired to its adapters; shared by the api and the worker processes. */
export const buildOrderCore = (dependencies: OrderCoreDependencies) => {
  const runner = new KyselyTransactionRunner(dependencies.db);
  const dispatcher = new InProcessDomainEventDispatcher();
  registerOrderIntegrationEvents(dispatcher, runner);
  const clock = dependencies.clock ?? new SystemClock();
  const store = new OrderStore(new KyselyOrderRepository(runner, clock), runner, dispatcher);
  const orderDao = new KyselyOrderDao(runner);
  return {
    runner,
    clock,
    orderDao,
    placeOrder: new PlaceOrder(store, dependencies.marketCatalog ?? JsonMarketCatalog.load(), dependencies.idGenerator ?? new UuidV7Generator(), clock),
    cancelOrder: new CancelOrder(store, clock),
    acceptOrder: new AcceptOrder(store, clock),
    rejectOrder: new RejectOrder(store),
    expireOrder: new ExpireOrder(store, clock, dependencies.pendingTimeoutMs ?? twoMinutes),
    applyFill: new ApplyFill(store),
    registerRemoval: new RegisterRemoval(store),
    revertCancelRequest: new RevertCancelRequest(store),
    getOrders: new GetOrders(orderDao),
    getOrder: new GetOrder(orderDao),
  };
};

export type OrderCore = ReturnType<typeof buildOrderCore>;

export interface OrderApiDependencies extends OrderCoreDependencies {
  readonly rateLimiter: RateLimiter;
  readonly rateLimits?: OrderRateLimits;
  readonly extraProbes?: readonly DependencyProbe[];
  readonly trustProxy?: string[] | boolean;
  readonly logger?: boolean;
}

export const buildOrderApi = (dependencies: OrderApiDependencies): { app: FastifyInstance; core: OrderCore } => {
  const core = buildOrderCore(dependencies);
  const app = Fastify({ logger: dependencies.logger ?? false, trustProxy: dependencies.trustProxy ?? false });
  registerErrorMapping(app, orderErrorMappings);
  registerRateLimit(app, { limiter: dependencies.rateLimiter, groups: orderRateLimitGroups(dependencies.rateLimits ?? defaultOrderRateLimits) });
  registerIdempotency(app, new KyselyIdempotencyStore(dependencies.db));
  registerHealthRoutes(app, serviceName, [new PostgresProbe(dependencies.db), ...(dependencies.extraProbes ?? [])]);
  registerOrderRoutes(app, core);
  return { app, core };
};

import type { Kysely } from 'kysely';
import type { Clock } from '../application/contracts/clock.js';
import type { IdGenerator } from '../application/contracts/idGenerator.js';
import { BookStore } from '../application/usecases/bookStore.js';
import { ExecuteOrder } from '../application/usecases/executeOrder.js';
import { RemoveOrder } from '../application/usecases/removeOrder.js';
import type { Database } from './database/database.js';
import { KyselyOrderBookRepository } from './database/kyselyOrderBookRepository.js';
import { KyselyTransactionRunner } from './database/kyselyTransactionRunner.js';
import { registerMatchingIntegrationEvents } from './messaging/matchingIntegrationEvents.js';
import { InProcessDomainEventDispatcher } from './platform/events/inProcessDomainEventDispatcher.js';
import { SystemClock, UuidV7Generator } from './system.js';

export const serviceName = 'matching';

export interface MatchingCoreDependencies {
  readonly db: Kysely<Database>;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export const buildMatchingCore = (dependencies: MatchingCoreDependencies) => {
  const runner = new KyselyTransactionRunner(dependencies.db);
  const dispatcher = new InProcessDomainEventDispatcher();
  registerMatchingIntegrationEvents(dispatcher, runner);
  const clock = dependencies.clock ?? new SystemClock();
  const store = new BookStore(new KyselyOrderBookRepository(runner), runner, dispatcher);
  return {
    runner,
    executeOrder: new ExecuteOrder(store, dependencies.idGenerator ?? new UuidV7Generator(), clock),
    removeOrder: new RemoveOrder(store, clock),
  };
};

export type MatchingCore = ReturnType<typeof buildMatchingCore>;

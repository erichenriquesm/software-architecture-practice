import Fastify from 'fastify';
import { buildOrderCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { registerHealthRoutes } from './http/health.js';
import { classifyOrderFailure } from './messaging/consumers/consumedEvent.js';
import { fundsReservationHandler, fundsReservationQueue } from './messaging/consumers/fundsReservationConsumer.js';
import { matchingResultsHandler, matchingResultsQueue, matchingResultsUnits } from './messaging/consumers/matchingResultsConsumer.js';
import { orderEventsExchange } from './messaging/orderIntegrationEvents.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import type { ConsumerOptions } from './platform/messaging/consumer.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { ReconnectingConnection } from './platform/messaging/reconnectingConnection.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { ExpirePendingOrders } from './scheduler/expirePendingOrders.js';
import { durationSetting, healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_003;
const purgeIntervalMs = 60 * 60 * 1_000;

const db = createDatabase(postgresSettings());
const pendingTimeoutMs = durationSetting('ORDER_PENDING_TIMEOUT', '2m');
const core = buildOrderCore({ db, pendingTimeoutMs });
const validate = loadEnvelopeValidator();
const log = Fastify({ logger: true }).log;

const consumerOptions: readonly Omit<ConsumerOptions, 'validate' | 'classify'>[] = [
  { definition: fundsReservationQueue, handler: fundsReservationHandler(core) },
  { definition: matchingResultsQueue, handler: matchingResultsHandler(core), units: matchingResultsUnits },
];

const startConsumer = async (connection: AmqpConnection, options: Omit<ConsumerOptions, 'validate' | 'classify'>): Promise<Consumer> => {
  const channel = await connection.createChannel();
  for (const binding of options.definition.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, options.definition);
  const consumer = new Consumer(core.runner, channel, { ...options, validate, classify: classifyOrderFailure });
  await consumer.start();
  return consumer;
};

/** Everything that lives on a broker connection; rebuilt from scratch on every reconnection. */
const attach = async (connection: AmqpConnection): Promise<() => Promise<void>> => {
  const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: orderEventsExchange, lockKey: outboxLockKey });
  relay.start();
  const consumers = await Promise.all(consumerOptions.map((options) => startConsumer(connection, options)));
  return async () => {
    relay.stop();
    await Promise.all(consumers.map((consumer) => consumer.stop().catch(() => undefined)));
  };
};

const broker = new ReconnectingConnection({
  connect: () => connectRabbitMq(rabbitMqUrlFromEnv()),
  setup: attach,
  onEvent: (event, detail) => log.info({ event, detail: detail instanceof Error ? detail.message : detail }, 'rabbitmq connection'),
});

const expirePendingOrders = new ExpirePendingOrders({
  orderDao: core.orderDao,
  expireOrder: core.expireOrder,
  clock: core.clock,
  pendingTimeoutMs,
  intervalMs: durationSetting('EXPIRE_PENDING_ORDERS_INTERVAL', '10s'),
  onError: (orderId, error) => log.warn({ orderId, error: error instanceof Error ? error.message : error }, 'could not expire order'),
});
expirePendingOrders.start();

const idempotencyStore = new KyselyIdempotencyStore(db);
const purge = setInterval(() => void idempotencyStore.purgeExpired(new Date()).catch(() => undefined), purgeIntervalMs);

const healthServer = Fastify({ logger: false });
registerHealthRoutes(healthServer, serviceName, [
  new PostgresProbe(db),
  { dependency: 'rabbitmq', isHealthy: async () => broker.isConnected() },
]);
await healthServer.listen({ host: '0.0.0.0', port: healthPortSetting() });
await broker.start();

const shutdown = async (): Promise<void> => {
  clearInterval(purge);
  expirePendingOrders.stop();
  await broker.stop();
  await healthServer.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

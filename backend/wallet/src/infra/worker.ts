import Fastify from 'fastify';
import { buildWalletCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { GrpcAccountGateway } from './grpc/account/grpcAccountGateway.js';
import { registerHealthRoutes } from './http/health.js';
import { accountCreatedHandler, accountCreatedQueue } from './messaging/consumers/accountCreatedConsumer.js';
import { classifyWalletFailure } from './messaging/consumers/consumedEvent.js';
import { orderPlacedHandler, orderPlacedQueue } from './messaging/consumers/orderPlacedConsumer.js';
import { orderRemovedHandler, orderRemovedQueue } from './messaging/consumers/orderRemovedConsumer.js';
import { orderVoidedHandler, orderVoidedQueue } from './messaging/consumers/orderVoidedConsumer.js';
import { tradeExecutedHandler, tradeExecutedQueue, tradeExecutedUnits } from './messaging/consumers/tradeExecutedConsumer.js';
import { walletEventsExchange } from './messaging/walletIntegrationEvents.js';
import { requiredEnv } from './platform/config/env.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import type { ConsumerOptions } from './platform/messaging/consumer.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { ReconnectingConnection } from './platform/messaging/reconnectingConnection.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { grpcIdentitySetting, healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_002;
const purgeIntervalMs = 60 * 60 * 1_000;

const db = createDatabase(postgresSettings());
const accountGateway = new GrpcAccountGateway({ address: requiredEnv('ACCOUNT_GRPC_ADDR'), identity: grpcIdentitySetting() });
const core = buildWalletCore({ db, accountGateway });
const validate = loadEnvelopeValidator();
const log = Fastify({ logger: true }).log;

const consumerOptions: readonly Omit<ConsumerOptions, 'validate' | 'classify'>[] = [
  { definition: accountCreatedQueue, handler: accountCreatedHandler(core.openWallet) },
  { definition: orderPlacedQueue, handler: orderPlacedHandler(core.reserveFunds) },
  { definition: tradeExecutedQueue, handler: tradeExecutedHandler(core.settleTradeSide), units: tradeExecutedUnits },
  { definition: orderRemovedQueue, handler: orderRemovedHandler(core.releaseReservation) },
  { definition: orderVoidedQueue, handler: orderVoidedHandler(core.compensateReservation) },
];

const startConsumer = async (connection: AmqpConnection, options: Omit<ConsumerOptions, 'validate' | 'classify'>): Promise<Consumer> => {
  const channel = await connection.createChannel();
  for (const binding of options.definition.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, options.definition);
  const consumer = new Consumer(core.runner, channel, { ...options, validate, classify: classifyWalletFailure });
  await consumer.start();
  return consumer;
};

/** Everything that lives on a broker connection; rebuilt from scratch on every reconnection. */
const attach = async (connection: AmqpConnection): Promise<() => Promise<void>> => {
  const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: walletEventsExchange, lockKey: outboxLockKey });
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
  await broker.stop();
  await healthServer.close();
  accountGateway.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

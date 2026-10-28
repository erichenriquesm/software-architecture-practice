import Fastify from 'fastify';
import { activeMarkets } from './catalog/activeMarkets.js';
import { buildMatchingCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { registerHealthRoutes } from './http/health.js';
import { classifyMatchingFailure } from './messaging/consumers/consumedEvent.js';
import { marketOrdersHandler, marketOrdersQueue } from './messaging/consumers/marketOrdersConsumer.js';
import { matchingEventsExchange } from './messaging/matchingIntegrationEvents.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { ReconnectingConnection } from './platform/messaging/reconnectingConnection.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_004;

const db = createDatabase(postgresSettings());
const core = buildMatchingCore({ db });
const validate = loadEnvelopeValidator();
const markets = activeMarkets();
const log = Fastify({ logger: true }).log;

const startMarketConsumer = async (connection: AmqpConnection, marketId: string): Promise<Consumer> => {
  const channel = await connection.createChannel();
  const definition = marketOrdersQueue(marketId);
  for (const binding of definition.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, definition);
  const consumer = new Consumer(core.runner, channel, { definition, handler: marketOrdersHandler(core), validate, classify: classifyMatchingFailure, prefetch: 1 });
  await consumer.start();
  return consumer;
};

/** Everything that lives on a broker connection; rebuilt from scratch on every reconnection. */
const attach = async (connection: AmqpConnection): Promise<() => Promise<void>> => {
  const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: matchingEventsExchange, lockKey: outboxLockKey });
  relay.start();
  const consumers = await Promise.all(markets.map((marketId) => startMarketConsumer(connection, marketId)));
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

const healthServer = Fastify({ logger: false });
registerHealthRoutes(healthServer, serviceName, [
  new PostgresProbe(db),
  { dependency: 'rabbitmq', isHealthy: async () => broker.isConnected() },
]);
await healthServer.listen({ host: '0.0.0.0', port: healthPortSetting() });
await broker.start();
log.info({ markets }, 'matching markets');

const shutdown = async (): Promise<void> => {
  await broker.stop();
  await healthServer.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

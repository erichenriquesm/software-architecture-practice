import Fastify from 'fastify';
import { buildMarketDataCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { registerHealthRoutes } from './http/health.js';
import { bookHandler, bookQueue } from './messaging/consumers/bookConsumer.js';
import { classifyMarketDataFailure } from './messaging/consumers/consumedEvent.js';
import { tradesHandler, tradesQueue } from './messaging/consumers/tradesConsumer.js';
import { declareMatchingLog, matchingLog } from './messaging/matchingLog.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import type { ConsumerOptions } from './platform/messaging/consumer.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { ReconnectingConnection } from './platform/messaging/reconnectingConnection.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { healthPortSetting, postgresSettings } from './settings.js';

const db = createDatabase(postgresSettings());
const core = buildMarketDataCore({ db });
const validate = loadEnvelopeValidator();
const log = Fastify({ logger: true }).log;

const consumerOptions: readonly Omit<ConsumerOptions, 'validate' | 'classify'>[] = [
  { definition: tradesQueue, handler: tradesHandler },
  { definition: bookQueue, handler: bookHandler(core.bookProjector), inbox: false },
];

const startConsumer = async (connection: AmqpConnection, options: Omit<ConsumerOptions, 'validate' | 'classify'>): Promise<Consumer> => {
  const channel = await connection.createChannel();
  for (const binding of options.definition.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, options.definition);
  const consumer = new Consumer(core.runner, channel, { ...options, validate, classify: classifyMarketDataFailure });
  await consumer.start();
  return consumer;
};

/** Everything that lives on a broker connection; rebuilt from scratch on every reconnection. */
const attach = async (connection: AmqpConnection): Promise<() => Promise<void>> => {
  const topology = await connection.createChannel();
  await topology.checkExchange(matchingLog.exchange);
  await declareMatchingLog(topology);
  await topology.close();
  const consumers = await Promise.all(consumerOptions.map((options) => startConsumer(connection, options)));
  return async () => {
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

const shutdown = async (): Promise<void> => {
  await broker.stop();
  await healthServer.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

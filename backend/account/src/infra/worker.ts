import Fastify from 'fastify';
import { buildAccountCore, serviceName } from './composition.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { registerHealthRoutes } from './http/health.js';
import { accountEventsExchange } from './messaging/accountIntegrationEvents.js';
import { classifyWalletBalancesFailure, walletBalancesHandler, walletBalancesQueue } from './messaging/walletBalancesConsumer.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import type { AmqpConnection } from './platform/messaging/connection.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { ReconnectingConnection } from './platform/messaging/reconnectingConnection.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_001;
const purgeIntervalMs = 60 * 60 * 1_000;

const db = createDatabase(postgresSettings());
const core = buildAccountCore(db);
const validate = loadEnvelopeValidator();
const log = Fastify({ logger: true }).log;

/** Everything that lives on a broker connection; rebuilt from scratch on every reconnection. */
const attach = async (connection: AmqpConnection): Promise<() => Promise<void>> => {
  const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: accountEventsExchange, lockKey: outboxLockKey });
  relay.start();

  const channel = await connection.createChannel();
  for (const binding of walletBalancesQueue.bindings) await channel.checkExchange(binding.exchange);
  await declareConsumerQueue(channel, walletBalancesQueue);
  const consumer = new Consumer(core.runner, channel, {
    definition: walletBalancesQueue,
    handler: walletBalancesHandler(core.projectWalletBalance),
    validate,
    classify: classifyWalletBalancesFailure,
  });
  await consumer.start();

  return async () => {
    relay.stop();
    await consumer.stop().catch(() => undefined);
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
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

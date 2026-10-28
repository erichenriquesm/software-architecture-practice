import Fastify from 'fastify';
import { registerHealthRoutes } from './http/health.js';
import {
  classifyWalletBalancesFailure,
  walletBalancesHandler,
  walletBalancesQueue,
} from './messaging/walletBalancesConsumer.js';
import { accountEventsExchange } from './messaging/accountIntegrationEvents.js';
import { createDatabase, PostgresProbe } from './database/postgres.js';
import { KyselyIdempotencyStore } from './platform/http/idempotency/idempotencyStore.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import { Consumer } from './platform/messaging/consumer.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { OutboxRelay } from './platform/messaging/outbox.js';
import { declareConsumerQueue } from './platform/messaging/topology.js';
import { buildAccountCore, serviceName } from './composition.js';
import { healthPortSetting, postgresSettings } from './settings.js';

const outboxLockKey = 7_001;
const purgeIntervalMs = 60 * 60 * 1_000;

const db = createDatabase(postgresSettings());
const core = buildAccountCore(db);
const connection = await connectRabbitMq(rabbitMqUrlFromEnv());

const relay = new OutboxRelay(db, await connection.createConfirmChannel(), { exchange: accountEventsExchange, lockKey: outboxLockKey });
relay.start();

const consumerChannel = await connection.createChannel();
await consumerChannel.checkExchange(walletBalancesQueue.bindings[0]?.exchange ?? 'wallet.events');
await declareConsumerQueue(consumerChannel, walletBalancesQueue);
const consumer = new Consumer(core.runner, consumerChannel, {
  definition: walletBalancesQueue,
  handler: walletBalancesHandler(core.projectWalletBalance),
  validate: loadEnvelopeValidator(),
  classify: classifyWalletBalancesFailure,
});
await consumer.start();

const idempotencyStore = new KyselyIdempotencyStore(db);
const purge = setInterval(() => void idempotencyStore.purgeExpired(new Date()).catch(() => undefined), purgeIntervalMs);

const healthServer = Fastify({ logger: false });
registerHealthRoutes(healthServer, serviceName, [new PostgresProbe(db)]);
await healthServer.listen({ host: '0.0.0.0', port: healthPortSetting() });

const shutdown = async (): Promise<void> => {
  clearInterval(purge);
  relay.stop();
  await consumer.stop();
  await healthServer.close();
  await connection.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

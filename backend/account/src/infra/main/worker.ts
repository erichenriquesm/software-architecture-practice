import Fastify from 'fastify';
import { GetServiceHealth } from '../../application/usecases/getServiceHealth/getServiceHealth.js';
import { ServiceName } from '../../domain/serviceName.js';
import { registerHealthRoutes } from '../adapters/inbound/http/healthRoutes.js';
import {
  classifyWalletBalancesFailure,
  walletBalancesHandler,
  walletBalancesQueue,
} from '../adapters/inbound/messaging/walletBalancesConsumer.js';
import { accountEventsExchange } from '../adapters/outbound/messaging/accountIntegrationEvents.js';
import { createDatabase, PostgresProbe } from '../adapters/outbound/persistence/postgres.js';
import { KyselyIdempotencyStore } from '../platform/http/idempotency/idempotencyStore.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from '../platform/messaging/connection.js';
import { Consumer } from '../platform/messaging/consumer.js';
import { loadEnvelopeValidator } from '../platform/messaging/envelope.js';
import { OutboxRelay } from '../platform/messaging/outbox.js';
import { declareConsumerQueue } from '../platform/messaging/topology.js';
import { buildAccountCore } from './composition.js';
import { postgresSettings } from './settings.js';

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
registerHealthRoutes(healthServer, new GetServiceHealth(ServiceName.from('account'), [new PostgresProbe(db)]));
await healthServer.listen({ host: '0.0.0.0', port: Number(process.env.HEALTH_PORT ?? 3001) });

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

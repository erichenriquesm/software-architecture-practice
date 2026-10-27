import Fastify from 'fastify';
import { GetServiceHealth } from '../../application/usecases/getServiceHealth/getServiceHealth.js';
import { ServiceName } from '../../domain/serviceName.js';
import { registerHealthRoutes } from '../adapters/inbound/http/healthRoutes.js';
import { createDatabase, PostgresProbe } from '../adapters/outbound/persistence/postgres.js';
import { postgresSettings, serviceNameSetting } from './settings.js';

const db = createDatabase(postgresSettings());
const getServiceHealth = new GetServiceHealth(ServiceName.from(serviceNameSetting()), [new PostgresProbe(db)]);

const healthServer = Fastify({ logger: false });
registerHealthRoutes(healthServer, getServiceHealth);

const shutdown = async (): Promise<void> => {
  await healthServer.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await healthServer.listen({ host: '0.0.0.0', port: Number(process.env.HEALTH_PORT ?? 3001) });

import Fastify from 'fastify';
import { GetServiceHealth } from '../../application/usecases/getServiceHealth/getServiceHealth.js';
import { ServiceName } from '../../domain/serviceName.js';
import { registerHealthRoutes } from '../adapters/inbound/http/healthRoutes.js';
import { createDatabase, PostgresProbe } from '../adapters/outbound/persistence/postgres.js';
import { httpPortSetting, postgresSettings, serviceNameSetting, trustedProxySubnets } from './settings.js';

const db = createDatabase(postgresSettings());
const getServiceHealth = new GetServiceHealth(ServiceName.from(serviceNameSetting()), [new PostgresProbe(db)]);

const app = Fastify({ logger: true, trustProxy: trustedProxySubnets() });
registerHealthRoutes(app, getServiceHealth);

const shutdown = async (): Promise<void> => {
  await app.close();
  await db.destroy();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: httpPortSetting() });

import type { FastifyInstance } from 'fastify';

export interface DependencyProbe {
  readonly dependency: string;
  isHealthy(): Promise<boolean>;
}

type Status = 'up' | 'down';

const statusOf = async (probe: DependencyProbe): Promise<[string, Status]> => {
  const healthy = await probe.isHealthy().catch(() => false);
  return [probe.dependency, healthy ? 'up' : 'down'];
};

export const registerHealthRoutes = (app: FastifyInstance, service: string, probes: readonly DependencyProbe[]): void => {
  app.get('/health', async (_request, reply) => {
    const checks = Object.fromEntries(await Promise.all(probes.map(statusOf)));
    const status: Status = Object.values(checks).every((check) => check === 'up') ? 'up' : 'down';
    return reply.status(status === 'up' ? 200 : 503).send({ service, status, checks });
  });
};

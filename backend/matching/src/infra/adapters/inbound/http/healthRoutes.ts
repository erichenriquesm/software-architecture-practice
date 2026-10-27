import type { FastifyInstance } from 'fastify';
import type { GetServiceHealth } from '../../../../application/usecases/getServiceHealth/getServiceHealth.js';

export const registerHealthRoutes = (app: FastifyInstance, getServiceHealth: GetServiceHealth): void => {
  app.get('/health', async (_request, reply) => {
    const getServiceHealthOutput = await getServiceHealth.execute({});
    const statusCode = getServiceHealthOutput.status === 'up' ? 200 : 503;
    return reply.status(statusCode).send(getServiceHealthOutput);
  });
};

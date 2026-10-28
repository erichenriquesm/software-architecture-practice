import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import type { DependencyProbe } from '../../../../src/infra/http/health.js';
import { registerHealthRoutes } from '../../../../src/infra/http/health.js';

const probe = (dependency: string, healthy: boolean | Error): DependencyProbe => ({
  dependency,
  isHealthy: async () => {
    if (healthy instanceof Error) throw healthy;
    return healthy;
  },
});

describe('GET /health', () => {
  test('Should answer 200 when every dependency is up', async () => {
    // Given
    const app = Fastify();
    registerHealthRoutes(app, 'matching', [probe('postgres', true)]);

    // When
    const response = await app.inject({ method: 'GET', url: '/health' });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: 'matching', status: 'up', checks: { postgres: 'up' } });
  });

  test('Should answer 503 and name the dependency that is down or throws', async () => {
    // Given
    const app = Fastify();
    registerHealthRoutes(app, 'matching', [probe('postgres', true), probe('rabbitmq', new Error('refused'))]);

    // When
    const response = await app.inject({ method: 'GET', url: '/health' });

    // Then
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ service: 'matching', status: 'down', checks: { postgres: 'up', rabbitmq: 'down' } });
  });
});

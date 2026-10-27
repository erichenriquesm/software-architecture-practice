import { describe, expect, test } from 'vitest';
import { ServiceName } from '../../../domain/serviceName.js';
import type { DependencyProbe } from '../../ports/dependencyProbe.js';
import { GetServiceHealth } from './getServiceHealth.js';

class FakeProbe implements DependencyProbe {
  constructor(
    readonly dependency: string,
    private readonly answer: boolean | Error,
  ) {}

  async isHealthy(): Promise<boolean> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const serviceName = ServiceName.from('service-template');

describe('Use case: GetServiceHealth', () => {
  test('Should report up when every dependency is healthy', async () => {
    // Given
    const getServiceHealth = new GetServiceHealth(serviceName, [
      new FakeProbe('postgres', true),
      new FakeProbe('rabbitmq', true),
    ]);

    // When
    const getServiceHealthOutput = await getServiceHealth.execute({});

    // Then
    expect(getServiceHealthOutput).toEqual({
      service: 'service-template',
      status: 'up',
      checks: { postgres: 'up', rabbitmq: 'up' },
    });
  });

  test('Should report down when one dependency is unhealthy', async () => {
    // Given
    const getServiceHealth = new GetServiceHealth(serviceName, [
      new FakeProbe('postgres', true),
      new FakeProbe('rabbitmq', false),
    ]);

    // When
    const getServiceHealthOutput = await getServiceHealth.execute({});

    // Then
    expect(getServiceHealthOutput.status).toBe('down');
    expect(getServiceHealthOutput.checks).toEqual({ postgres: 'up', rabbitmq: 'down' });
  });

  test('Should treat a probe that throws as unhealthy instead of failing', async () => {
    // Given
    const getServiceHealth = new GetServiceHealth(serviceName, [new FakeProbe('redis', new Error('timeout'))]);

    // When
    const getServiceHealthOutput = await getServiceHealth.execute({});

    // Then
    expect(getServiceHealthOutput).toEqual({ service: 'service-template', status: 'down', checks: { redis: 'down' } });
  });

  test('Should report up when there is nothing to check', async () => {
    // Given
    const getServiceHealth = new GetServiceHealth(serviceName, []);

    // When
    const getServiceHealthOutput = await getServiceHealth.execute({});

    // Then
    expect(getServiceHealthOutput.status).toBe('up');
  });
});

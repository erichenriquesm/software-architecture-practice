import type { ServiceName } from './serviceName.js';

export interface DependencyCheck {
  readonly dependency: string;
  readonly healthy: boolean;
}

export type HealthStatus = 'up' | 'down';

export class HealthReport {
  private constructor(
    readonly serviceName: ServiceName,
    readonly checks: readonly DependencyCheck[],
  ) {}

  static of(serviceName: ServiceName, checks: readonly DependencyCheck[]): HealthReport {
    return new HealthReport(serviceName, [...checks]);
  }

  status(): HealthStatus {
    const allHealthy = this.checks.every((check) => check.healthy);
    return allHealthy ? 'up' : 'down';
  }
}

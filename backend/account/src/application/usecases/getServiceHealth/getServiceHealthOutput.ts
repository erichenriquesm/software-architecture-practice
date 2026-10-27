import type { HealthStatus } from '../../../domain/healthReport.js';

export interface GetServiceHealthOutput {
  readonly service: string;
  readonly status: HealthStatus;
  readonly checks: Readonly<Record<string, HealthStatus>>;
}

import type { DependencyCheck } from '../../../domain/healthReport.js';
import { HealthReport } from '../../../domain/healthReport.js';
import type { ServiceName } from '../../../domain/serviceName.js';
import type { DependencyProbe } from '../../ports/dependencyProbe.js';
import type { UseCase } from '../../useCase.js';
import type { GetServiceHealthInput } from './getServiceHealthInput.js';
import type { GetServiceHealthOutput } from './getServiceHealthOutput.js';

export class GetServiceHealth implements UseCase<GetServiceHealthInput, GetServiceHealthOutput> {
  constructor(
    private readonly serviceName: ServiceName,
    private readonly probes: readonly DependencyProbe[],
  ) {}

  async execute(_input: GetServiceHealthInput): Promise<GetServiceHealthOutput> {
    const checks = await Promise.all(this.probes.map((probe) => checkOf(probe)));
    const report = HealthReport.of(this.serviceName, checks);

    const output: GetServiceHealthOutput = {
      service: report.serviceName.value,
      status: report.status(),
      checks: Object.fromEntries(checks.map((check) => [check.dependency, check.healthy ? 'up' : 'down'])),
    };
    return output;
  }
}

const checkOf = async (probe: DependencyProbe): Promise<DependencyCheck> => ({
  dependency: probe.dependency,
  healthy: await probe.isHealthy().catch(() => false),
});

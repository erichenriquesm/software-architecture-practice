import type { BalanceProjection } from '../../ports/accountPorts.js';
import type { UseCase } from '../../useCase.js';
import type { ProjectWalletBalanceInput } from './projectWalletBalanceInput.js';
import type { ProjectWalletBalanceOutput } from './projectWalletBalanceOutput.js';

export class ProjectWalletBalance implements UseCase<ProjectWalletBalanceInput, ProjectWalletBalanceOutput> {
  constructor(private readonly balanceProjection: BalanceProjection) {}

  async execute(input: ProjectWalletBalanceInput): Promise<ProjectWalletBalanceOutput> {
    const output: ProjectWalletBalanceOutput = { applied: await this.balanceProjection.applyIfNewer(input) };
    return output;
  }
}

import type { BalanceProjection } from '../contracts/balanceProjection.js';
import type { UseCase } from './useCase.js';
import type { ProjectWalletBalanceInput } from '../dtos/projectWalletBalanceDto.js';
import type { ProjectWalletBalanceOutput } from '../dtos/projectWalletBalanceDto.js';

export class ProjectWalletBalance implements UseCase<ProjectWalletBalanceInput, ProjectWalletBalanceOutput> {
  constructor(private readonly balanceProjection: BalanceProjection) {}

  async execute(input: ProjectWalletBalanceInput): Promise<ProjectWalletBalanceOutput> {
    const output: ProjectWalletBalanceOutput = { applied: await this.balanceProjection.applyIfNewer(input) };
    return output;
  }
}

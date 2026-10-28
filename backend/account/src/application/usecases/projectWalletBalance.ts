import type { BalanceProjection } from '../contracts/balanceProjection.js';
import type { BalanceChange } from '../dtos/balanceView.js';
import type { UseCase } from './useCase.js';

export class ProjectWalletBalance implements UseCase<[change: BalanceChange], boolean> {
  constructor(private readonly balanceProjection: BalanceProjection) {}

  async execute(change: BalanceChange): Promise<boolean> {
    return this.balanceProjection.applyIfNewer(change);
  }
}

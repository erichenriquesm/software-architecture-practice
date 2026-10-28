import { describe, expect, test } from 'vitest';
import type { BalanceProjection } from '../../../../src/application/contracts/balanceProjection.js';
import type { BalanceChange } from '../../../../src/application/dtos/balanceView.js';
import { ProjectWalletBalance } from '../../../../src/application/usecases/projectWalletBalance.js';

class InMemoryBalanceProjection implements BalanceProjection {
  readonly versions = new Map<string, number>();

  async applyIfNewer(change: BalanceChange): Promise<boolean> {
    const key = `${change.accountId}:${change.assetId}`;
    if ((this.versions.get(key) ?? 0) >= change.version) return false;
    this.versions.set(key, change.version);
    return true;
  }
}

const change = (version: number): BalanceChange => ({ accountId: 'a', assetId: 'USD', available: '1', reserved: '0', version });

describe('Use case: ProjectWalletBalance', () => {
  test('Should report whether the change was applied, ignoring an older version', async () => {
    // Given
    const projectWalletBalance = new ProjectWalletBalance(new InMemoryBalanceProjection());

    // When & Then
    await expect(projectWalletBalance.execute(change(2))).resolves.toBe(true);
    await expect(projectWalletBalance.execute(change(1))).resolves.toBe(false);
  });
});

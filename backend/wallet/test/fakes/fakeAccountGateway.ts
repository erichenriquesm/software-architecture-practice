import type { AccountGateway } from '../../src/application/contracts/accountGateway.js';

export class FakeAccountGateway implements AccountGateway {
  calls = 0;

  constructor(private readonly existing: readonly string[] = []) {}

  async exists(accountId: string): Promise<boolean> {
    this.calls += 1;
    return this.existing.includes(accountId);
  }
}

import type { AccountRepository } from '../../src/application/contracts/accountRepository.js';
import type { Account } from '../../src/domain/entities/account.js';
import type { Email } from '../../src/domain/valueObjects/email.js';

export class FakeAccountRepository implements AccountRepository {
  readonly saved: Account[] = [];

  constructor(private readonly takenEmails: readonly string[] = []) {}

  async existsByEmail(email: Email): Promise<boolean> {
    return this.takenEmails.includes(email.value);
  }

  async save(account: Account): Promise<void> {
    this.saved.push(account);
  }
}

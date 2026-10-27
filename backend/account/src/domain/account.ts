import { AggregateRoot } from './aggregateRoot.js';
import type { DomainEvent } from './aggregateRoot.js';
import type { AccountId, Cpf, Email, FullName, PasswordHash } from './valueObjects.js';

export interface AccountCreated extends DomainEvent {
  readonly type: 'AccountCreated';
  readonly accountId: string;
}

export interface SignUpData {
  readonly id: AccountId;
  readonly name: FullName;
  readonly email: Email;
  readonly document: Cpf;
  readonly passwordHash: PasswordHash;
  readonly now: Date;
}

export class Account extends AggregateRoot<AccountCreated> {
  private constructor(
    readonly id: AccountId,
    readonly name: FullName,
    readonly email: Email,
    readonly document: Cpf,
    readonly passwordHash: PasswordHash,
    readonly createdAt: Date,
  ) {
    super();
  }

  static signUp(data: SignUpData): Account {
    const account = new Account(data.id, data.name, data.email, data.document, data.passwordHash, data.now);
    account.recordEvent({ type: 'AccountCreated', accountId: data.id.value, occurredAt: data.now });
    return account;
  }
}

import type { AccountCreated } from '../domainEvents/accountCreated.js';
import type { AccountId } from '../valueObjects/accountId.js';
import type { Cpf } from '../valueObjects/cpf.js';
import type { Email } from '../valueObjects/email.js';
import type { FullName } from '../valueObjects/fullName.js';
import type { PasswordHash } from '../valueObjects/passwordHash.js';
import { AggregateRoot } from './aggregateRoot.js';

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

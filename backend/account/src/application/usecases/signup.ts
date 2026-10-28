import { Account } from '../../domain/entities/account.js';
import { DuplicateEmailError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { Cpf } from '../../domain/valueObjects/cpf.js';
import { Email } from '../../domain/valueObjects/email.js';
import { FullName } from '../../domain/valueObjects/fullName.js';
import { Password } from '../../domain/valueObjects/password.js';
import type { AccountRepository } from '../contracts/accountRepository.js';
import type { PasswordHasher } from '../contracts/passwordHasher.js';
import type { DomainEventDispatcher } from '../contracts/domainEventDispatcher.js';
import type { Clock } from '../contracts/clock.js';
import type { IdGenerator } from '../contracts/idGenerator.js';
import type { TransactionRunner } from '../contracts/transactionRunner.js';
import type { UseCase } from './useCase.js';
import type { SignupInput } from '../dtos/signupDto.js';

export class Signup implements UseCase<[input: SignupInput], string> {
  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly transactionRunner: TransactionRunner,
    private readonly domainEventDispatcher: DomainEventDispatcher,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: SignupInput): Promise<string> {
    const account = await this.newAccount(input);

    await this.transactionRunner.run(async () => {
      await this.accountRepository.save(account);
      await this.domainEventDispatcher.dispatch(account.pullEvents());
    });

    return account.id.value;
  }

  private async newAccount(input: SignupInput): Promise<Account> {
    const name = FullName.from(input.name);
    const email = Email.from(input.email);
    const document = Cpf.from(input.document);
    const password = Password.from(input.password);
    if (await this.accountRepository.existsByEmail(email)) throw new DuplicateEmailError();

    const passwordHash = await this.passwordHasher.hash(password);
    const id = AccountId.from(this.idGenerator.next());
    return Account.signUp({ id, name, email, document, passwordHash, now: this.clock.now() });
  }
}

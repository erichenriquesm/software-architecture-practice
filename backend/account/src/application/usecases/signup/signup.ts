import { Account } from '../../../domain/account.js';
import { DuplicateEmailError } from '../../../domain/errors.js';
import { AccountId, Cpf, Email, FullName, Password } from '../../../domain/valueObjects.js';
import type { AccountRepository, PasswordHasher } from '../../ports/accountPorts.js';
import type { DomainEventDispatcher } from '../../ports/domainEventDispatcher.js';
import type { Clock, IdGenerator } from '../../ports/system.js';
import type { TransactionRunner } from '../../ports/transactionRunner.js';
import type { UseCase } from '../../useCase.js';
import type { SignupInput } from './signupInput.js';
import type { SignupOutput } from './signupOutput.js';

export class Signup implements UseCase<SignupInput, SignupOutput> {
  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly transactionRunner: TransactionRunner,
    private readonly domainEventDispatcher: DomainEventDispatcher,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: SignupInput): Promise<SignupOutput> {
    const account = await this.newAccount(input);

    await this.transactionRunner.run(async () => {
      await this.accountRepository.save(account);
      await this.domainEventDispatcher.dispatch(account.pullEvents());
    });

    const output: SignupOutput = { accountId: account.id.value };
    return output;
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

import { Wallet } from '../../domain/entities/wallet.js';
import { WalletNotFoundError } from '../../domain/errors.js';
import type { AccountId } from '../../domain/valueObjects/accountId.js';
import type { AccountGateway } from '../contracts/accountGateway.js';
import type { DomainEventDispatcher } from '../contracts/domainEventDispatcher.js';
import type { TransactionRunner } from '../contracts/transactionRunner.js';
import type { WalletRepository } from '../contracts/walletRepository.js';

/** The steps every wallet command shares: load (or open) the wallet, then save it and dispatch its events atomically. */
export class WalletStore {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly accountGateway: AccountGateway,
    private readonly transactionRunner: TransactionRunner,
    private readonly domainEventDispatcher: DomainEventDispatcher,
  ) {}

  async load(accountId: AccountId): Promise<Wallet> {
    const wallet = await this.walletRepository.findByAccount(accountId);
    if (!wallet) throw new WalletNotFoundError(accountId.value);
    return wallet;
  }

  /** The stored wallet, or a new one when the account exists but account.created has not arrived yet. */
  async loadOrOpen(accountId: AccountId): Promise<Wallet> {
    const stored = await this.walletRepository.findByAccount(accountId);
    if (stored) return stored;
    if (!(await this.accountGateway.exists(accountId.value))) throw new WalletNotFoundError(accountId.value);
    return Wallet.open(accountId);
  }

  persist(wallet: Wallet): Promise<void> {
    return this.transactionRunner.run(async () => {
      await this.walletRepository.save(wallet);
      await this.domainEventDispatcher.dispatch(wallet.pullEvents());
    });
  }
}

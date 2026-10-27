import { AccountNotFoundError } from '../../domain/errors.js';
import { Wallet } from '../../domain/wallet.js';
import type { DomainEventDispatcher } from '../ports/domainEventDispatcher.js';
import type { AccountGateway, WalletRepository } from '../ports/walletPorts.js';
import { ConcurrencyConflictError } from '../ports/walletPorts.js';
import type { TransactionRunner } from '../ports/transactionRunner.js';

export interface WalletUnitOfWork {
  readonly walletRepository: WalletRepository;
  readonly accountGateway: AccountGateway;
  readonly transactionRunner: TransactionRunner;
  readonly domainEventDispatcher: DomainEventDispatcher;
}

const maxAttempts = 3;

export const retryOnConflict = async <T>(work: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ConcurrencyConflictError) || attempt >= maxAttempts) throw error;
    }
  }
};

export const ensureWallet = async (unit: WalletUnitOfWork, accountId: string, now: Date): Promise<Wallet> => {
  const existing = await unit.walletRepository.findByAccount(accountId);
  if (existing) return existing;
  if (!(await unit.accountGateway.exists(accountId))) throw new AccountNotFoundError(accountId);
  return Wallet.open(accountId, now);
};

export const saveAndDispatch = async (unit: WalletUnitOfWork, wallet: Wallet): Promise<void> => {
  await unit.walletRepository.save(wallet);
  await unit.domainEventDispatcher.dispatch(wallet.pullEvents());
};

export const changeWallet = (
  unit: WalletUnitOfWork,
  accountId: string,
  now: Date,
  change: (wallet: Wallet) => void,
): Promise<void> =>
  retryOnConflict(async () => {
    const wallet = await ensureWallet(unit, accountId, now);
    change(wallet);
    await unit.transactionRunner.run(() => saveAndDispatch(unit, wallet));
  });

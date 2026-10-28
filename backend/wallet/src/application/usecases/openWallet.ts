import { Wallet } from '../../domain/entities/wallet.js';
import { ConcurrentWalletUpdateError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { WalletRepository } from '../contracts/walletRepository.js';
import type { UseCase } from './useCase.js';
import type { WalletStore } from './walletStore.js';

/** account.created → an empty wallet. Opening twice (or racing a deposit that opened it) is not an error. */
export class OpenWallet implements UseCase<[accountId: string], void> {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly walletStore: WalletStore,
  ) {}

  async execute(rawAccountId: string): Promise<void> {
    const accountId = AccountId.from(rawAccountId);
    if (await this.walletRepository.findByAccount(accountId)) return;
    await this.walletStore.persist(Wallet.open(accountId)).catch((error: unknown) => {
      if (!(error instanceof ConcurrentWalletUpdateError)) throw error;
    });
  }
}

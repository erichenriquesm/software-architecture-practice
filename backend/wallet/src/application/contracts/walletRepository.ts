import type { Wallet } from '../../domain/entities/wallet.js';
import type { AccountId } from '../../domain/valueObjects/accountId.js';

export interface WalletRepository {
  findByAccount(accountId: AccountId): Promise<Wallet | undefined>;
  /** Saves balances, reservations and ledger. Throws ConcurrentWalletUpdateError when the stored version moved. */
  save(wallet: Wallet): Promise<void>;
}

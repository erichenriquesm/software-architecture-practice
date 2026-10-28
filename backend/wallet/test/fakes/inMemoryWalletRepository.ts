import type { WalletRepository } from '../../src/application/contracts/walletRepository.js';
import type { ReservationData } from '../../src/domain/entities/reservation.js';
import { Reservation } from '../../src/domain/entities/reservation.js';
import { Wallet } from '../../src/domain/entities/wallet.js';
import { ConcurrentWalletUpdateError } from '../../src/domain/errors.js';
import type { AccountId } from '../../src/domain/valueObjects/accountId.js';
import type { Balance } from '../../src/domain/valueObjects/balance.js';

interface StoredWallet {
  readonly accountId: AccountId;
  readonly version: number;
  readonly balances: ReadonlyMap<string, Balance>;
  readonly reservations: readonly ReservationData[];
}

/** Keeps a copy of each saved wallet and checks the version like the real repository. */
export class InMemoryWalletRepository implements WalletRepository {
  private readonly stored = new Map<string, StoredWallet>();
  saves = 0;
  conflictsToSimulate = 0;

  async findByAccount(accountId: AccountId): Promise<Wallet | undefined> {
    const stored = this.stored.get(accountId.value);
    if (!stored) return undefined;
    return Wallet.restore({ ...stored, reservations: stored.reservations.filter((data) => data.status === 'open').map(Reservation.restore) });
  }

  async save(wallet: Wallet): Promise<void> {
    const current = this.stored.get(wallet.accountId.value)?.version ?? 0;
    if (this.conflictsToSimulate > 0 || current !== wallet.version) {
      this.conflictsToSimulate = Math.max(0, this.conflictsToSimulate - 1);
      throw new ConcurrentWalletUpdateError(wallet.accountId.value);
    }
    this.saves += 1;
    this.stored.set(wallet.accountId.value, {
      accountId: wallet.accountId,
      version: wallet.nextVersion,
      balances: new Map(wallet.allBalances()),
      reservations: wallet.allReservations().map((reservation) => reservation.snapshot),
    });
  }
}

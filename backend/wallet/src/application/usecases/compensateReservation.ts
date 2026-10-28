import { AccountId } from '../../domain/valueObjects/accountId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import type { Clock } from '../contracts/clock.js';
import type { TransactionRunner } from '../contracts/transactionRunner.js';
import type { VoidedOrders } from '../contracts/voidedOrders.js';
import type { WalletRepository } from '../contracts/walletRepository.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';
import type { WalletStore } from './walletStore.js';

/**
 * Saga S2 compensation (order.voided): writes the tombstone first, then frees whatever is still reserved.
 * The wallet is read inside the transaction, after the tombstone lock, so a reservation that raced it is seen.
 */
export class CompensateReservation implements UseCase<[orderId: string, accountId: string], void> {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly walletStore: WalletStore,
    private readonly voidedOrders: VoidedOrders,
    private readonly transactionRunner: TransactionRunner,
    private readonly clock: Clock,
  ) {}

  async execute(rawOrderId: string, rawAccountId: string): Promise<void> {
    const orderId = OrderId.from(rawOrderId);
    const accountId = AccountId.from(rawAccountId);

    await retryOnConflict(() =>
      this.transactionRunner.run(async () => {
        await this.voidedOrders.markVoided(orderId);
        const wallet = await this.walletRepository.findByAccount(accountId);
        wallet?.voidReservation(orderId, this.clock.now());
        if (!wallet || wallet.pendingLedger().length === 0) return;
        await this.walletStore.persist(wallet);
      }),
    );
  }
}

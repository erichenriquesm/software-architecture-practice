import { AccountId } from '../../domain/valueObjects/accountId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import type { Clock } from '../contracts/clock.js';
import type { ReleaseReservationInput } from '../dtos/releaseReservationDto.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';
import type { WalletStore } from './walletStore.js';

/** Saga S4 (and self-trade prevention): the order left the book, so what it did not execute goes back to available. */
export class ReleaseReservation implements UseCase<[input: ReleaseReservationInput], void> {
  constructor(
    private readonly walletStore: WalletStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: ReleaseReservationInput): Promise<void> {
    const accountId = AccountId.from(input.accountId);
    const orderId = OrderId.from(input.orderId);
    const remainingQuantity = Quantity.from(input.remainingQuantity);

    await retryOnConflict(async () => {
      const wallet = await this.walletStore.load(accountId);
      wallet.releaseRemaining(orderId, remainingQuantity, this.clock.now());
      await this.walletStore.persist(wallet);
    });
  }
}

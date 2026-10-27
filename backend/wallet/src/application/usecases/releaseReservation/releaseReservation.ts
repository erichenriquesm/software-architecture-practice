import { ReservationNotFoundError } from '../../../domain/errors.js';
import { Amount, uuidOf } from '../../../domain/valueObjects.js';
import type { Clock } from '../../ports/system.js';
import type { WalletUnitOfWork } from '../../support/walletSupport.js';
import { retryOnConflict, saveAndDispatch } from '../../support/walletSupport.js';
import type { UseCase } from '../../useCase.js';
import type { ReleaseReservationInput } from './releaseReservationInput.js';
import type { ReleaseReservationOutput } from './releaseReservationOutput.js';

export class ReleaseReservation implements UseCase<ReleaseReservationInput, ReleaseReservationOutput> {
  constructor(
    private readonly unit: WalletUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: ReleaseReservationInput): Promise<ReleaseReservationOutput> {
    const orderId = uuidOf('orderId', input.orderId);
    const remaining = Amount.of('remainingQuantity', input.remainingQuantity);
    await retryOnConflict(async () => {
      const wallet = await this.unit.walletRepository.findByAccount(uuidOf('accountId', input.accountId));
      if (!wallet) throw new ReservationNotFoundError(orderId);
      wallet.releaseRemaining(orderId, remaining, this.clock.now());
      await this.unit.transactionRunner.run(() => saveAndDispatch(this.unit, wallet));
    });
  }
}

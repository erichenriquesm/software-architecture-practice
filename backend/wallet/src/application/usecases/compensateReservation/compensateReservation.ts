import { uuidOf } from '../../../domain/valueObjects.js';
import type { Clock } from '../../ports/system.js';
import type { VoidedOrders } from '../../ports/walletPorts.js';
import type { WalletUnitOfWork } from '../../support/walletSupport.js';
import { retryOnConflict, saveAndDispatch } from '../../support/walletSupport.js';
import type { UseCase } from '../../useCase.js';
import type { CompensateReservationInput } from './compensateReservationInput.js';
import type { CompensateReservationOutput } from './compensateReservationOutput.js';

export class CompensateReservation implements UseCase<CompensateReservationInput, CompensateReservationOutput> {
  constructor(
    private readonly unit: WalletUnitOfWork,
    private readonly voidedOrders: VoidedOrders,
    private readonly clock: Clock,
  ) {}

  async execute(input: CompensateReservationInput): Promise<CompensateReservationOutput> {
    const orderId = uuidOf('orderId', input.orderId);
    const accountId = uuidOf('accountId', input.accountId);
    await retryOnConflict(async () => {
      const wallet = await this.unit.walletRepository.findByAccount(accountId);
      wallet?.voidReservation(orderId, this.clock.now());
      await this.unit.transactionRunner.run(async () => {
        await this.voidedOrders.markVoided(orderId);
        if (wallet) await saveAndDispatch(this.unit, wallet);
      });
    });
  }
}

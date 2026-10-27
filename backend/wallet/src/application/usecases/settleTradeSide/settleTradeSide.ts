import { ReservationNotFoundError } from '../../../domain/errors.js';
import { Amount, uuidOf } from '../../../domain/valueObjects.js';
import type { Clock } from '../../ports/system.js';
import type { MarketCatalog } from '../../ports/walletPorts.js';
import type { WalletUnitOfWork } from '../../support/walletSupport.js';
import { retryOnConflict, saveAndDispatch } from '../../support/walletSupport.js';
import type { UseCase } from '../../useCase.js';
import type { SettleTradeSideInput } from './settleTradeSideInput.js';
import type { SettleTradeSideOutput } from './settleTradeSideOutput.js';

export class SettleTradeSide implements UseCase<SettleTradeSideInput, SettleTradeSideOutput> {
  constructor(
    private readonly unit: WalletUnitOfWork,
    private readonly marketCatalog: MarketCatalog,
    private readonly clock: Clock,
  ) {}

  async execute(input: SettleTradeSideInput): Promise<SettleTradeSideOutput> {
    const orderId = uuidOf('orderId', input.orderId);
    const trade = {
      tradeId: uuidOf('tradeId', input.tradeId),
      orderId,
      market: this.marketCatalog.market(input.marketId),
      quantity: Amount.positive('quantity', input.quantity),
      price: Amount.positive('price', input.price),
    };
    await retryOnConflict(async () => {
      const now = this.clock.now();
      const wallet = await this.unit.walletRepository.findByAccount(uuidOf('accountId', input.accountId));
      if (!wallet) throw new ReservationNotFoundError(orderId);
      if (input.role === 'buyer') wallet.settleAsBuyer(trade, now);
      if (input.role === 'seller') wallet.settleAsSeller(trade, now);
      await this.unit.transactionRunner.run(() => saveAndDispatch(this.unit, wallet));
    });
  }
}

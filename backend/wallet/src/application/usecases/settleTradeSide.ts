import type { ExecutedTrade } from '../../domain/entities/wallet.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import type { Clock } from '../contracts/clock.js';
import type { SettleTradeSideInput } from '../dtos/settleTradeSideDto.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';
import type { WalletStore } from './walletStore.js';

const tradeFrom = (input: SettleTradeSideInput): ExecutedTrade => ({
  tradeId: input.tradeId,
  orderId: OrderId.from(input.orderId),
  market: MarketId.from(input.marketId),
  quantity: Quantity.from(input.quantity),
  price: Price.from(input.price),
});

/** Saga S3: settles one side of a trade. The consumer calls it once for the buyer and once for the seller. */
export class SettleTradeSide implements UseCase<[input: SettleTradeSideInput], void> {
  constructor(
    private readonly walletStore: WalletStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: SettleTradeSideInput): Promise<void> {
    const accountId = AccountId.from(input.accountId);
    const trade = tradeFrom(input);

    await retryOnConflict(async () => {
      const wallet = await this.walletStore.load(accountId);
      if (input.role === 'buyer') wallet.settleAsBuyer(trade, this.clock.now());
      if (input.role === 'seller') wallet.settleAsSeller(trade, this.clock.now());
      await this.walletStore.persist(wallet);
    });
  }
}

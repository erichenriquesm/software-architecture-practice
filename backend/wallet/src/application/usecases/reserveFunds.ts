import type { OrderToReserve, Wallet } from '../../domain/entities/wallet.js';
import type { FundsReservationRejected, ReservationRejectionReason } from '../../domain/domainEvents/fundsReservationRejected.js';
import { InsufficientFundsError, WalletNotFoundError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { Clock } from '../contracts/clock.js';
import type { DomainEventDispatcher } from '../contracts/domainEventDispatcher.js';
import type { MarketCatalog } from '../contracts/marketCatalog.js';
import type { TransactionRunner } from '../contracts/transactionRunner.js';
import type { VoidedOrders } from '../contracts/voidedOrders.js';
import type { ReserveFundsInput } from '../dtos/reserveFundsDto.js';
import { retryOnConflict } from './retryOnConflict.js';
import type { UseCase } from './useCase.js';
import type { WalletStore } from './walletStore.js';

const missingAsUndefined = (error: unknown): undefined => {
  if (error instanceof WalletNotFoundError) return undefined;
  throw error;
};

const lackOfFundsAsFalse = (error: unknown): false => {
  if (error instanceof InsufficientFundsError) return false;
  throw error;
};

/**
 * Step 2 of saga S2. A business refusal (no funds, no account) is an event, never an exception, so the
 * order service can compensate. An order already voided (tombstone) never gets a reservation.
 */
export class ReserveFunds implements UseCase<[input: ReserveFundsInput], void> {
  constructor(
    private readonly walletStore: WalletStore,
    private readonly voidedOrders: VoidedOrders,
    private readonly marketCatalog: MarketCatalog,
    private readonly transactionRunner: TransactionRunner,
    private readonly domainEventDispatcher: DomainEventDispatcher,
    private readonly clock: Clock,
  ) {}

  async execute(input: ReserveFundsInput): Promise<void> {
    const accountId = AccountId.from(input.accountId);
    const order = this.orderFrom(input);
    await retryOnConflict(() => this.reserveOnce(accountId, order));
  }

  private async reserveOnce(accountId: AccountId, order: OrderToReserve): Promise<void> {
    const wallet = await this.walletStore.loadOrOpen(accountId).catch(missingAsUndefined);
    await this.transactionRunner.run(async () => {
      if (await this.voidedOrders.isVoided(order.orderId)) return;
      if (!wallet) return this.reject(accountId, order, 'WALLET_NOT_FOUND');
      if (!this.tryReserve(wallet, order)) return this.reject(accountId, order, 'INSUFFICIENT_FUNDS');
      return this.walletStore.persist(wallet);
    });
  }

  private tryReserve(wallet: Wallet, order: OrderToReserve): boolean {
    try {
      wallet.reserve(order, this.clock.now());
      return true;
    } catch (error) {
      return lackOfFundsAsFalse(error);
    }
  }

  private reject(accountId: AccountId, order: OrderToReserve, reason: ReservationRejectionReason): Promise<void> {
    const event: FundsReservationRejected = {
      type: 'FundsReservationRejected',
      orderId: order.orderId.value,
      accountId: accountId.value,
      reason,
      occurredAt: this.clock.now(),
    };
    return this.domainEventDispatcher.dispatch([event]);
  }

  private orderFrom(input: ReserveFundsInput): OrderToReserve {
    const market = MarketId.from(input.marketId);
    this.marketCatalog.ensureMarket(market);
    return {
      orderId: OrderId.from(input.orderId),
      market,
      side: Side.from(input.side),
      quantity: Quantity.from(input.quantity),
      price: Price.from(input.price),
    };
  }
}

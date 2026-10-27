import { AccountNotFoundError } from '../../../domain/errors.js';
import { Amount, sideOf, uuidOf } from '../../../domain/valueObjects.js';
import type { OrderToReserve } from '../../../domain/wallet.js';
import type { Clock } from '../../ports/system.js';
import type { MarketCatalog, VoidedOrders } from '../../ports/walletPorts.js';
import type { WalletUnitOfWork } from '../../support/walletSupport.js';
import { ensureWallet, retryOnConflict, saveAndDispatch } from '../../support/walletSupport.js';
import type { UseCase } from '../../useCase.js';
import type { ReserveFundsInput } from './reserveFundsInput.js';
import type { ReserveFundsOutput } from './reserveFundsOutput.js';

export class ReserveFunds implements UseCase<ReserveFundsInput, ReserveFundsOutput> {
  constructor(
    private readonly unit: WalletUnitOfWork,
    private readonly voidedOrders: VoidedOrders,
    private readonly marketCatalog: MarketCatalog,
    private readonly clock: Clock,
  ) {}

  async execute(input: ReserveFundsInput): Promise<ReserveFundsOutput> {
    const orderId = uuidOf('orderId', input.orderId);
    const accountId = uuidOf('accountId', input.accountId);
    if (await this.voidedOrders.isVoided(orderId)) return;

    const order: OrderToReserve = {
      orderId,
      market: this.marketCatalog.market(input.marketId),
      side: sideOf(input.side),
      quantity: Amount.positive('quantity', input.quantity),
      price: Amount.positive('price', input.price),
    };
    await retryOnConflict(() => this.reserve(accountId, order));
  }

  private async reserve(accountId: string, order: OrderToReserve): Promise<void> {
    const now = this.clock.now();
    const wallet = await ensureWallet(this.unit, accountId, now).catch((error: unknown) => {
      if (error instanceof AccountNotFoundError) return undefined;
      throw error;
    });
    if (!wallet) return this.rejectWithoutWallet(accountId, order.orderId, now);

    wallet.reserve(order, now);
    await this.unit.transactionRunner.run(() => saveAndDispatch(this.unit, wallet));
  }

  private rejectWithoutWallet(accountId: string, orderId: string, now: Date): Promise<void> {
    const rejected = { type: 'FundsReservationRejected' as const, orderId, accountId, reason: 'WALLET_NOT_FOUND' as const, occurredAt: now };
    return this.unit.transactionRunner.run(() => this.unit.domainEventDispatcher.dispatch([rejected]));
  }
}

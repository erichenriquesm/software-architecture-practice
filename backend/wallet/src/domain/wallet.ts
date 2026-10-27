import { Decimal } from 'decimal.js';
import { AggregateRoot } from './aggregateRoot.js';
import { InsufficientFundsError, InvalidWalletDataError, ReservationNotFoundError } from './errors.js';
import { Reservation } from './reservation.js';
import type { Asset, Market, Side } from './valueObjects.js';
import { Amount, internalScale } from './valueObjects.js';
import type { Movement, MovementReason, WalletEvent } from './walletEvents.js';

export interface Balance {
  readonly available: Amount;
  readonly reserved: Amount;
}

export interface OrderToReserve {
  readonly orderId: string;
  readonly market: Market;
  readonly side: Side;
  readonly quantity: Amount;
  readonly price: Amount;
}

export interface TradeSide {
  readonly tradeId: string;
  readonly orderId: string;
  readonly market: Market;
  readonly quantity: Amount;
  readonly price: Amount;
}

export interface WalletSnapshot {
  readonly accountId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly balances: ReadonlyMap<string, Balance>;
  readonly reservations: readonly Reservation[];
}

const emptyBalance: Balance = { available: Amount.zero(), reserved: Amount.zero() };

const withinScale = (amount: Amount): Amount => {
  if (amount.value.decimalPlaces() > internalScale) throw new InvalidWalletDataError('amount', `exceeds ${internalScale} decimals`);
  return amount;
};

export class Wallet extends AggregateRoot<WalletEvent> {
  private version: number;
  private readonly touchedAssets = new Set<string>();
  private movements: Movement[] = [];

  private constructor(
    readonly accountId: string,
    readonly persistedVersion: number,
    readonly createdAt: Date,
    private readonly balances: Map<string, Balance>,
    private readonly reservations: Map<string, Reservation>,
  ) {
    super();
    this.version = persistedVersion;
  }

  static open(accountId: string, now: Date): Wallet {
    return new Wallet(accountId, 0, now, new Map(), new Map());
  }

  static restore(snapshot: WalletSnapshot): Wallet {
    const reservations = new Map(snapshot.reservations.map((reservation) => [reservation.orderId, reservation]));
    return new Wallet(snapshot.accountId, snapshot.version, snapshot.createdAt, new Map(snapshot.balances), reservations);
  }

  get currentVersion(): number {
    return this.version;
  }

  balanceOf(assetId: string): Balance {
    return this.balances.get(assetId) ?? emptyBalance;
  }

  snapshotBalances(): ReadonlyMap<string, Balance> {
    return new Map(this.balances);
  }

  snapshotReservations(): readonly Reservation[] {
    return [...this.reservations.values()];
  }

  hasOpenReservation(orderId: string): boolean {
    return this.reservations.get(orderId)?.status === 'open';
  }

  pullMovements(): Movement[] {
    const movements = this.movements;
    this.movements = [];
    return movements;
  }

  deposit(asset: Asset, quantity: string, referenceId: string, now: Date): void {
    const amount = Amount.positive('quantity', quantity, asset.precision);
    this.change(asset.assetId, amount.value, new Decimal(0), 'DEPOSIT', referenceId);
    this.commit(now);
  }

  withdraw(asset: Asset, quantity: string, referenceId: string, now: Date): void {
    const amount = Amount.positive('quantity', quantity, asset.precision);
    this.change(asset.assetId, amount.value.negated(), new Decimal(0), 'WITHDRAW', referenceId);
    this.commit(now);
  }

  reserve(order: OrderToReserve, now: Date): void {
    if (this.reservations.has(order.orderId)) return;
    const asset = order.side === 'buy' ? order.market.quote : order.market.base;
    const amount = withinScale(order.side === 'buy' ? order.quantity.times(order.price) : order.quantity);

    if (this.balanceOf(asset.assetId).available.isLessThan(amount)) {
      this.recordEvent({ type: 'FundsReservationRejected', orderId: order.orderId, accountId: this.accountId, reason: 'INSUFFICIENT_FUNDS', occurredAt: now });
      return;
    }
    this.change(asset.assetId, amount.value.negated(), amount.value, 'RESERVE', order.orderId);
    this.reservations.set(order.orderId, Reservation.open(order.orderId, asset.assetId, order.side, order.price, amount, now));
    this.recordEvent({ type: 'FundsReserved', orderId: order.orderId, accountId: this.accountId, assetId: asset.assetId, amount: amount.toString(), occurredAt: now });
    this.commit(now);
  }

  settleAsBuyer(trade: TradeSide, now: Date): void {
    const reservation = this.openReservation(trade.orderId);
    const reservedPart = withinScale(trade.quantity.times(reservation.limitPrice));
    const paid = withinScale(trade.quantity.times(trade.price));
    reservation.consume(reservedPart);
    this.change(trade.market.quote.assetId, reservedPart.minus(paid).value, reservedPart.value.negated(), 'SETTLE', trade.tradeId);
    this.change(trade.market.base.assetId, trade.quantity.value, new Decimal(0), 'SETTLE', trade.tradeId);
    this.commit(now);
  }

  settleAsSeller(trade: TradeSide, now: Date): void {
    const reservation = this.openReservation(trade.orderId);
    reservation.consume(trade.quantity);
    this.change(trade.market.base.assetId, new Decimal(0), trade.quantity.value.negated(), 'SETTLE', trade.tradeId);
    this.change(trade.market.quote.assetId, withinScale(trade.quantity.times(trade.price)).value, new Decimal(0), 'SETTLE', trade.tradeId);
    this.commit(now);
  }

  releaseRemaining(orderId: string, remainingQuantity: Amount, now: Date): void {
    const reservation = this.openReservation(orderId);
    const amount = withinScale(reservation.side === 'buy' ? remainingQuantity.times(reservation.limitPrice) : remainingQuantity);
    reservation.consume(amount);
    this.change(reservation.assetId, amount.value, amount.value.negated(), 'RELEASE', orderId);
    this.commit(now);
  }

  voidReservation(orderId: string, now: Date): void {
    const reservation = this.reservations.get(orderId);
    if (reservation?.status !== 'open') return;
    const released = reservation.void();
    this.change(reservation.assetId, released.value, released.value.negated(), 'VOID', orderId);
    this.commit(now);
  }

  private openReservation(orderId: string): Reservation {
    const reservation = this.reservations.get(orderId);
    if (reservation?.status !== 'open') throw new ReservationNotFoundError(orderId);
    return reservation;
  }

  private change(assetId: string, availableDelta: Decimal, reservedDelta: Decimal, reason: MovementReason, referenceId: string): void {
    const current = this.balanceOf(assetId);
    const available = current.available.value.plus(availableDelta);
    const reserved = current.reserved.value.plus(reservedDelta);
    if (available.isNegative()) throw new InsufficientFundsError(assetId);
    if (reserved.isNegative()) throw new InvalidWalletDataError('reserved', `${assetId} would become negative`);

    this.balances.set(assetId, { available: Amount.fromDecimal(available), reserved: Amount.fromDecimal(reserved) });
    this.movements.push({ assetId, availableDelta: availableDelta.toFixed(internalScale), reservedDelta: reservedDelta.toFixed(internalScale), reason, referenceId });
    this.touchedAssets.add(assetId);
  }

  private commit(now: Date): void {
    this.version += 1;
    for (const assetId of this.touchedAssets) this.recordEvent(this.balanceChanged(assetId, now));
    this.touchedAssets.clear();
  }

  private balanceChanged(assetId: string, now: Date): WalletEvent {
    const balance = this.balanceOf(assetId);
    return {
      type: 'BalanceChanged',
      accountId: this.accountId,
      assetId,
      available: balance.available.toString(),
      reserved: balance.reserved.toString(),
      version: this.version,
      occurredAt: now,
    };
  }
}

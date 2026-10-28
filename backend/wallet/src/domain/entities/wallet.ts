import type { BalanceChanged } from '../domainEvents/balanceChanged.js';
import type { DomainEvent } from '../domainEvents/domainEvent.js';
import type { FundsReserved } from '../domainEvents/fundsReserved.js';
import { InvalidWalletDataError, ReservationNotFoundError } from '../errors.js';
import type { AccountId } from '../valueObjects/accountId.js';
import type { AssetId } from '../valueObjects/assetId.js';
import { Balance } from '../valueObjects/balance.js';
import type { MarketId } from '../valueObjects/marketId.js';
import type { OrderId } from '../valueObjects/orderId.js';
import type { Price } from '../valueObjects/price.js';
import type { Quantity } from '../valueObjects/quantity.js';
import type { Side } from '../valueObjects/side.js';
import { AggregateRoot } from './aggregateRoot.js';
import type { LedgerEntry, LedgerReason } from './ledgerEntry.js';
import { Reservation } from './reservation.js';

export interface OrderToReserve {
  readonly orderId: OrderId;
  readonly market: MarketId;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: Price;
}

export interface ExecutedTrade {
  readonly tradeId: string;
  readonly orderId: OrderId;
  readonly market: MarketId;
  readonly quantity: Quantity;
  readonly price: Price;
}

export interface WalletSnapshot {
  readonly accountId: AccountId;
  readonly version: number;
  readonly balances: ReadonlyMap<string, Balance>;
  readonly reservations: readonly Reservation[];
}

interface Movement {
  readonly asset: AssetId;
  readonly next: Balance;
  readonly availableDelta: string;
  readonly reservedDelta: string;
  readonly reason: LedgerReason;
  readonly referenceId: string | null;
}

/**
 * One wallet per account. Invariants: available >= 0 and reserved >= 0 per asset, and the reserved
 * amount of an asset equals what its open reservations still hold. Settle and release consume exactly
 * their own part of a reservation, so they give the same result in any order.
 */
export class Wallet extends AggregateRoot<DomainEvent> {
  private readonly ledger: LedgerEntry[] = [];
  private readonly changedAssets = new Map<string, Date>();

  private constructor(
    readonly accountId: AccountId,
    readonly version: number,
    private readonly balances: Map<string, Balance>,
    private readonly reservations: Map<string, Reservation>,
  ) {
    super();
  }

  static open(accountId: AccountId): Wallet {
    return new Wallet(accountId, 0, new Map(), new Map());
  }

  static restore(snapshot: WalletSnapshot): Wallet {
    const reservations = new Map(snapshot.reservations.map((reservation) => [reservation.snapshot.orderId.value, reservation]));
    return new Wallet(snapshot.accountId, snapshot.version, new Map(snapshot.balances), reservations);
  }

  /** The version this wallet will have once saved; it is also the version of its BalanceChanged events. */
  get nextVersion(): number {
    return this.version + 1;
  }

  isNew(): boolean {
    return this.version === 0;
  }

  balanceOf(asset: AssetId): Balance {
    return this.balances.get(asset.value) ?? Balance.empty();
  }

  allBalances(): ReadonlyMap<string, Balance> {
    return this.balances;
  }

  allReservations(): readonly Reservation[] {
    return [...this.reservations.values()];
  }

  pendingLedger(): readonly LedgerEntry[] {
    return this.ledger;
  }

  deposit(asset: AssetId, quantity: Quantity, precision: number, now: Date): void {
    this.ensureMovable(quantity, precision);
    const next = this.balanceOf(asset).credit(quantity);
    this.apply({ asset, next, availableDelta: quantity.toString(), reservedDelta: '0', reason: 'DEPOSIT', referenceId: null }, now);
  }

  withdraw(asset: AssetId, quantity: Quantity, precision: number, now: Date): void {
    this.ensureMovable(quantity, precision);
    const next = this.balanceOf(asset).debit(quantity, asset);
    this.apply({ asset, next, availableDelta: `-${quantity.toString()}`, reservedDelta: '0', reason: 'WITHDRAW', referenceId: null }, now);
  }

  /** Buy: reserves quantity × price of the quote asset. Sell: reserves quantity of the base asset. A repeated order is ignored. */
  reserve(order: OrderToReserve, now: Date): void {
    if (this.reservations.has(order.orderId.value)) return;
    const asset = order.side.isBuy() ? order.market.quote : order.market.base;
    const amount = order.side.isBuy() ? order.quantity.times(order.price) : order.quantity;
    if (amount.isZero()) throw new InvalidWalletDataError('quantity', 'must be greater than zero');

    const next = this.balanceOf(asset).reserve(amount, asset);
    this.reservations.set(order.orderId.value, Reservation.open(order.orderId, asset, order.side, order.price, amount, now));
    this.apply({ asset, next, availableDelta: `-${amount.toString()}`, reservedDelta: amount.toString(), reason: 'RESERVE', referenceId: order.orderId.value }, now);
    this.recordEvent(this.fundsReserved(order.orderId, asset, amount, now));
  }

  /** The buyer pays the maker's price: the difference to its own limit goes back to available. */
  settleAsBuyer(trade: ExecutedTrade, now: Date): void {
    const reservation = this.openReservation(trade.orderId);
    if (trade.price.isGreaterThan(reservation.limitPrice)) throw new InvalidWalletDataError('price', 'a buyer never pays above its limit');
    const reservedPart = reservation.amountFor(trade.quantity);
    const refund = reservedPart.minus(trade.quantity.times(trade.price));
    reservation.consume(reservedPart);

    const quote = trade.market.quote;
    const quoteNext = this.balanceOf(quote).consumeReserved(reservedPart).credit(refund);
    this.apply({ asset: quote, next: quoteNext, availableDelta: refund.toString(), reservedDelta: `-${reservedPart.toString()}`, reason: 'SETTLE', referenceId: trade.tradeId }, now);
    this.credit(trade.market.base, trade.quantity, trade.tradeId, now);
  }

  settleAsSeller(trade: ExecutedTrade, now: Date): void {
    const reservation = this.openReservation(trade.orderId);
    reservation.consume(trade.quantity);

    const base = trade.market.base;
    const baseNext = this.balanceOf(base).consumeReserved(trade.quantity);
    this.apply({ asset: base, next: baseNext, availableDelta: '0', reservedDelta: `-${trade.quantity.toString()}`, reason: 'SETTLE', referenceId: trade.tradeId }, now);
    this.credit(trade.market.quote, trade.quantity.times(trade.price), trade.tradeId, now);
  }

  /** The order left the book with `remainingQuantity` not executed: its share of the reservation goes back to available. */
  releaseRemaining(orderId: OrderId, remainingQuantity: Quantity, now: Date): void {
    const reservation = this.openReservation(orderId);
    const amount = reservation.amountFor(remainingQuantity);
    if (amount.isZero()) return;
    reservation.consume(amount);
    this.releaseTo(reservation.assetId, amount, 'RELEASE', orderId, now);
  }

  /** S2 compensation: an order voided before it reached the book gives back everything still reserved. */
  voidReservation(orderId: OrderId, now: Date): void {
    const reservation = this.reservations.get(orderId.value);
    if (!reservation?.isOpen()) return;
    this.releaseTo(reservation.assetId, reservation.voidRemaining(), 'VOID', orderId, now);
  }

  override pullEvents(): DomainEvent[] {
    return [...super.pullEvents(), ...this.balanceChangedEvents()];
  }

  private ensureMovable(quantity: Quantity, precision: number): void {
    if (quantity.isZero()) throw new InvalidWalletDataError('quantity', 'must be greater than zero');
    if (!quantity.fitsPrecision(precision)) throw new InvalidWalletDataError('quantity', `accepts at most ${precision} decimal places for this asset`);
  }

  private openReservation(orderId: OrderId): Reservation {
    const reservation = this.reservations.get(orderId.value);
    if (!reservation?.isOpen()) throw new ReservationNotFoundError(orderId.value);
    return reservation;
  }

  private credit(asset: AssetId, quantity: Quantity, referenceId: string, now: Date): void {
    const next = this.balanceOf(asset).credit(quantity);
    this.apply({ asset, next, availableDelta: quantity.toString(), reservedDelta: '0', reason: 'SETTLE', referenceId }, now);
  }

  private releaseTo(asset: AssetId, amount: Quantity, reason: LedgerReason, orderId: OrderId, now: Date): void {
    const next = this.balanceOf(asset).release(amount);
    this.apply({ asset, next, availableDelta: amount.toString(), reservedDelta: `-${amount.toString()}`, reason, referenceId: orderId.value }, now);
  }

  private apply(movement: Movement, now: Date): void {
    const { asset, next, ...entry } = movement;
    this.balances.set(asset.value, next);
    this.ledger.push({ assetId: asset.value, ...entry, createdAt: now });
    this.changedAssets.set(asset.value, now);
  }

  private fundsReserved(orderId: OrderId, asset: AssetId, amount: Quantity, now: Date): FundsReserved {
    return { type: 'FundsReserved', orderId: orderId.value, accountId: this.accountId.value, assetId: asset.value, amount: amount.toString(), occurredAt: now };
  }

  private balanceChangedEvents(): BalanceChanged[] {
    const events = [...this.changedAssets.entries()].map(([assetId, occurredAt]) => this.balanceChanged(assetId, occurredAt));
    this.changedAssets.clear();
    return events;
  }

  private balanceChanged(assetId: string, occurredAt: Date): BalanceChanged {
    const balance = this.balances.get(assetId) ?? Balance.empty();
    return {
      type: 'BalanceChanged',
      accountId: this.accountId.value,
      assetId,
      available: balance.available.toString(),
      reserved: balance.reserved.toString(),
      version: this.nextVersion,
      occurredAt,
    };
  }
}

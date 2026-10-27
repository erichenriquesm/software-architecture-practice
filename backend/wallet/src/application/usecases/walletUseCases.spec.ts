import { describe, expect, test } from 'vitest';
import type { DomainEvent } from '../../domain/aggregateRoot.js';
import { AccountNotFoundError } from '../../domain/errors.js';
import type { Asset, Market } from '../../domain/valueObjects.js';
import type { Wallet } from '../../domain/wallet.js';
import { Wallet as WalletAggregate } from '../../domain/wallet.js';
import type { DomainEventDispatcher } from '../ports/domainEventDispatcher.js';
import type { TransactionRunner } from '../ports/transactionRunner.js';
import type { AccountGateway, BalanceDao, MarketCatalog, VoidedOrders, WalletRepository } from '../ports/walletPorts.js';
import { ConcurrencyConflictError } from '../ports/walletPorts.js';
import type { WalletUnitOfWork } from '../support/walletSupport.js';
import { CompensateReservation } from './compensateReservation/compensateReservation.js';
import { Deposit } from './deposit/deposit.js';
import { GetBalances, WalletNotFoundError } from './getBalances/getBalances.js';
import { ReserveFunds } from './reserveFunds/reserveFunds.js';

const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const orderId = '0199d5f4-0000-7000-8000-000000000001';
const now = new Date('2026-10-27T12:00:00Z');
const clock = { now: () => now };
const btc: Asset = { assetId: 'BTC', precision: 8 };
const usd: Asset = { assetId: 'USD', precision: 2 };
const market: Market = { marketId: 'BTC-USD', base: btc, quote: usd };
const catalog: MarketCatalog = { market: () => market, asset: (assetId) => (assetId === 'BTC' ? btc : usd) };

class FakeWalletRepository implements WalletRepository {
  readonly wallets = new Map<string, Wallet>();
  saves = 0;
  constructor(private conflictsLeft = 0) {}

  async findByAccount(id: string): Promise<Wallet | undefined> {
    return this.wallets.get(id);
  }

  async save(wallet: Wallet): Promise<void> {
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1;
      throw new ConcurrencyConflictError(wallet.accountId);
    }
    this.saves += 1;
    this.wallets.set(wallet.accountId, wallet);
  }
}

class RecordingDispatcher implements DomainEventDispatcher {
  readonly events: DomainEvent[] = [];
  async dispatch(events: readonly DomainEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

const passThrough: TransactionRunner = { run: (work) => work() };

const unitWith = (repository: FakeWalletRepository, accountExists: boolean, dispatcher = new RecordingDispatcher()) => {
  const gateway: AccountGateway = { exists: async () => accountExists };
  const unit: WalletUnitOfWork = { walletRepository: repository, accountGateway: gateway, transactionRunner: passThrough, domainEventDispatcher: dispatcher };
  return { unit, dispatcher };
};

const noVoided: VoidedOrders = { isVoided: async () => false, markVoided: async () => undefined };
const typesOf = (events: DomainEvent[]) => events.map((event) => event.type);

describe('Use case: Deposit', () => {
  test('Should open the wallet on the spot when the account service confirms the account exists', async () => {
    // Given
    const repository = new FakeWalletRepository();
    const { unit, dispatcher } = unitWith(repository, true);

    // When
    await new Deposit(unit, catalog, clock).execute({ accountId, assetId: 'USD', quantity: '250', referenceId: 'r-1' });

    // Then
    expect(repository.wallets.get(accountId)?.balanceOf('USD').available.toString()).toBe('250.00000000');
    expect(typesOf(dispatcher.events)).toEqual(['BalanceChanged']);
  });

  test('Should fail with AccountNotFoundError when the account does not exist', async () => {
    // Given
    const { unit } = unitWith(new FakeWalletRepository(), false);

    // When & Then
    await expect(new Deposit(unit, catalog, clock).execute({ accountId, assetId: 'USD', quantity: '1', referenceId: 'r' })).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });

  test('Should reload and retry when the wallet was changed concurrently', async () => {
    // Given
    const repository = new FakeWalletRepository(2);
    const { unit } = unitWith(repository, true);

    // When
    await new Deposit(unit, catalog, clock).execute({ accountId, assetId: 'USD', quantity: '1', referenceId: 'r' });

    // Then
    expect(repository.saves).toBe(1);
  });

  test('Should give up after three concurrent conflicts', async () => {
    // Given
    const { unit } = unitWith(new FakeWalletRepository(3), true);

    // When & Then
    await expect(new Deposit(unit, catalog, clock).execute({ accountId, assetId: 'USD', quantity: '1', referenceId: 'r' })).rejects.toBeInstanceOf(
      ConcurrencyConflictError,
    );
  });
});

describe('Use case: ReserveFunds', () => {
  const placed = { orderId, accountId, marketId: 'BTC-USD', side: 'buy', quantity: '0.01', price: '50000' };

  test('Should reject with WALLET_NOT_FOUND as an event when the account does not exist', async () => {
    // Given
    const { unit, dispatcher } = unitWith(new FakeWalletRepository(), false);

    // When
    await new ReserveFunds(unit, noVoided, catalog, clock).execute(placed);

    // Then
    expect(dispatcher.events).toEqual([{ type: 'FundsReservationRejected', orderId, accountId, reason: 'WALLET_NOT_FOUND', occurredAt: now }]);
  });

  test('Should reject with INSUFFICIENT_FUNDS as an event when the wallet cannot cover the order', async () => {
    // Given
    const repository = new FakeWalletRepository();
    repository.wallets.set(accountId, WalletAggregate.open(accountId, now));
    const { unit, dispatcher } = unitWith(repository, true);

    // When
    await new ReserveFunds(unit, noVoided, catalog, clock).execute(placed);

    // Then
    expect(dispatcher.events).toMatchObject([{ type: 'FundsReservationRejected', reason: 'INSUFFICIENT_FUNDS' }]);
  });

  test('Should not reserve for an order that was already voided', async () => {
    // Given
    const repository = new FakeWalletRepository();
    const { unit, dispatcher } = unitWith(repository, true);
    const voided: VoidedOrders = { isVoided: async () => true, markVoided: async () => undefined };

    // When
    await new ReserveFunds(unit, voided, catalog, clock).execute(placed);

    // Then
    expect(dispatcher.events).toEqual([]);
    expect(repository.saves).toBe(0);
  });
});

describe('Use case: CompensateReservation', () => {
  test('Should write the tombstone and release an open reservation', async () => {
    // Given
    const repository = new FakeWalletRepository();
    const wallet = WalletAggregate.open(accountId, now);
    wallet.deposit(usd, '1000', 'seed', now);
    await new ReserveFunds(unitWith(repository, true).unit, noVoided, catalog, clock).execute({
      orderId,
      accountId,
      marketId: 'BTC-USD',
      side: 'buy',
      quantity: '0.01',
      price: '50000',
    }).catch(() => undefined);
    repository.wallets.set(accountId, wallet);
    wallet.reserve({ orderId, market, side: 'buy', quantity: (await import('../../domain/valueObjects.js')).Amount.of('q', '0.01'), price: (await import('../../domain/valueObjects.js')).Amount.of('p', '50000') }, now);
    wallet.pullEvents();
    const marked: string[] = [];
    const voided: VoidedOrders = { isVoided: async () => false, markVoided: async (id) => void marked.push(id) };
    const { unit, dispatcher } = unitWith(repository, true);

    // When
    await new CompensateReservation(unit, voided, clock).execute({ orderId, accountId });

    // Then
    expect(marked).toEqual([orderId]);
    expect(wallet.balanceOf('USD').available.toString()).toBe('1000.00000000');
    expect(typesOf(dispatcher.events)).toEqual(['BalanceChanged']);
  });

  test('Should only write the tombstone when the wallet does not exist yet', async () => {
    // Given
    const marked: string[] = [];
    const voided: VoidedOrders = { isVoided: async () => false, markVoided: async (id) => void marked.push(id) };
    const { unit, dispatcher } = unitWith(new FakeWalletRepository(), true);

    // When
    await new CompensateReservation(unit, voided, clock).execute({ orderId, accountId });

    // Then
    expect(marked).toEqual([orderId]);
    expect(dispatcher.events).toEqual([]);
  });
});

describe('Use case: GetBalances', () => {
  test('Should fail with WalletNotFoundError when there is no wallet', async () => {
    const dao: BalanceDao = { balancesOf: async () => undefined };

    await expect(new GetBalances(dao).execute({ accountId })).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

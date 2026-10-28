import { CompensateReservation } from '../../../../src/application/usecases/compensateReservation.js';
import { Deposit } from '../../../../src/application/usecases/deposit.js';
import { OpenWallet } from '../../../../src/application/usecases/openWallet.js';
import { ReleaseReservation } from '../../../../src/application/usecases/releaseReservation.js';
import { ReserveFunds } from '../../../../src/application/usecases/reserveFunds.js';
import { SettleTradeSide } from '../../../../src/application/usecases/settleTradeSide.js';
import { WalletStore } from '../../../../src/application/usecases/walletStore.js';
import { Withdraw } from '../../../../src/application/usecases/withdraw.js';
import { FakeAccountGateway } from '../../../fakes/fakeAccountGateway.js';
import { FakeMarketCatalog } from '../../../fakes/fakeMarketCatalog.js';
import { fixedClock } from '../../../fakes/fixedSystem.js';
import { InMemoryVoidedOrders } from '../../../fakes/inMemoryVoidedOrders.js';
import { InMemoryWalletRepository } from '../../../fakes/inMemoryWalletRepository.js';
import { RecordingDomainEventDispatcher } from '../../../fakes/recordingDomainEventDispatcher.js';
import { RecordingTransactionRunner } from '../../../fakes/recordingTransactionRunner.js';

export const accountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
export const otherAccountId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a70';
export const orderId = '0199d5f4-2b9a-7c3e-9a51-000000000001';
export const now = new Date('2026-10-28T12:00:00Z');

/** Every wallet use case wired to in-memory fakes; only `accountId` exists in the account service. */
export const walletUseCases = () => {
  const repository = new InMemoryWalletRepository();
  const accountGateway = new FakeAccountGateway([accountId]);
  const voidedOrders = new InMemoryVoidedOrders();
  const runner = new RecordingTransactionRunner();
  const dispatcher = new RecordingDomainEventDispatcher();
  const catalog = new FakeMarketCatalog();
  const clock = fixedClock(now);
  const store = new WalletStore(repository, accountGateway, runner, dispatcher);
  return {
    repository,
    accountGateway,
    voidedOrders,
    dispatcher,
    openWallet: new OpenWallet(repository, store),
    deposit: new Deposit(store, catalog, clock),
    withdraw: new Withdraw(store, catalog, clock),
    reserveFunds: new ReserveFunds(store, voidedOrders, catalog, runner, dispatcher, clock),
    settleTradeSide: new SettleTradeSide(store, clock),
    releaseReservation: new ReleaseReservation(store, clock),
    compensateReservation: new CompensateReservation(repository, store, voidedOrders, runner, clock),
  };
};

import type { Market, Asset } from '../../domain/valueObjects.js';
import type { Wallet } from '../../domain/wallet.js';

export class ConcurrencyConflictError extends Error {
  constructor(readonly accountId: string) {
    super(`wallet ${accountId} was changed concurrently`);
    this.name = 'ConcurrencyConflictError';
  }
}

export class AccountServiceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('account service unavailable', { cause });
    this.name = 'AccountServiceUnavailableError';
  }
}

export interface WalletRepository {
  findByAccount(accountId: string): Promise<Wallet | undefined>;
  save(wallet: Wallet): Promise<void>;
}

export interface AccountGateway {
  exists(accountId: string): Promise<boolean>;
}

export interface VoidedOrders {
  isVoided(orderId: string): Promise<boolean>;
  markVoided(orderId: string): Promise<void>;
}

export interface MarketCatalog {
  market(marketId: string): Market;
  asset(assetId: string): Asset;
}

export interface BalanceView {
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
}

export interface WalletBalancesView {
  readonly balances: readonly BalanceView[];
  readonly version: number;
}

export interface BalanceDao {
  balancesOf(accountId: string): Promise<WalletBalancesView | undefined>;
}

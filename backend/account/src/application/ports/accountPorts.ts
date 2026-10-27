import type { Account } from '../../domain/account.js';
import type { Email, Password, PasswordHash } from '../../domain/valueObjects.js';

export interface AccountRepository {
  existsByEmail(email: Email): Promise<boolean>;
  save(account: Account): Promise<void>;
}

export interface PasswordHasher {
  hash(password: Password): Promise<PasswordHash>;
}

export interface AccountView {
  readonly accountId: string;
  readonly name: string;
  readonly email: string;
  readonly document: string;
}

export interface AccountDao {
  findById(accountId: string): Promise<AccountView | undefined>;
  exists(accountId: string): Promise<boolean>;
}

export interface AssetBalance {
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
}

export type BalancesStatus = 'ok' | 'live' | 'unavailable';

export interface AccountBalancesResult {
  readonly status: BalancesStatus;
  readonly balances: readonly AssetBalance[];
}

export interface AccountBalances {
  of(accountId: string): Promise<AccountBalancesResult>;
}

export interface BalanceChange {
  readonly accountId: string;
  readonly assetId: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: number;
}

export interface BalanceProjection {
  applyIfNewer(change: BalanceChange): Promise<boolean>;
}

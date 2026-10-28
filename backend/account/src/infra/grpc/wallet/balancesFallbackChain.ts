import type { AccountBalances } from '../../../application/contracts/accountBalances.js';
import type { AccountBalancesResult, AssetBalance } from '../../../application/dtos/balanceView.js';
import { FallbackHandler } from '../../platform/resilience/fallbackHandler.js';

export interface BalancesSource {
  listByAccount(accountId: string): Promise<AssetBalance[]>;
}

export interface LiveBalancesSource {
  balancesOf(accountId: string): Promise<AssetBalance[]>;
}

class NoProjectionYetError extends Error {}

class ProjectionLink extends FallbackHandler<string, AccountBalancesResult> {
  constructor(
    private readonly projection: BalancesSource,
    next: FallbackHandler<string, AccountBalancesResult>,
  ) {
    super(next);
  }

  protected async tryHandle(accountId: string): Promise<AccountBalancesResult> {
    const balances = await this.projection.listByAccount(accountId);
    if (balances.length === 0) throw new NoProjectionYetError();
    return { status: 'ok', balances };
  }
}

class WalletLink extends FallbackHandler<string, AccountBalancesResult> {
  constructor(
    private readonly wallet: LiveBalancesSource,
    next: FallbackHandler<string, AccountBalancesResult>,
  ) {
    super(next);
  }

  protected async tryHandle(accountId: string): Promise<AccountBalancesResult> {
    return { status: 'live', balances: await this.wallet.balancesOf(accountId) };
  }
}

class DegradedLink extends FallbackHandler<string, AccountBalancesResult> {
  constructor(private readonly onDegraded: (accountId: string) => void) {
    super();
  }

  protected async tryHandle(accountId: string): Promise<AccountBalancesResult> {
    this.onDegraded(accountId);
    return { status: 'unavailable', balances: [] };
  }
}

export class BalancesFallbackChain implements AccountBalances {
  private readonly chain: FallbackHandler<string, AccountBalancesResult>;

  constructor(projection: BalancesSource, wallet: LiveBalancesSource, onDegraded: (accountId: string) => void = () => undefined) {
    this.chain = new ProjectionLink(projection, new WalletLink(wallet, new DegradedLink(onDegraded)));
  }

  of(accountId: string): Promise<AccountBalancesResult> {
    return this.chain.handle(accountId);
  }
}

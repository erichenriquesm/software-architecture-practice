import { uuidOf } from '../../../domain/valueObjects.js';
import type { Clock } from '../../ports/system.js';
import type { MarketCatalog } from '../../ports/walletPorts.js';
import type { WalletUnitOfWork } from '../../support/walletSupport.js';
import { changeWallet } from '../../support/walletSupport.js';
import type { UseCase } from '../../useCase.js';
import type { WithdrawInput } from './withdrawInput.js';
import type { WithdrawOutput } from './withdrawOutput.js';

export class Withdraw implements UseCase<WithdrawInput, WithdrawOutput> {
  constructor(
    private readonly unit: WalletUnitOfWork,
    private readonly marketCatalog: MarketCatalog,
    private readonly clock: Clock,
  ) {}

  async execute(input: WithdrawInput): Promise<WithdrawOutput> {
    const asset = this.marketCatalog.asset(input.assetId);
    const now = this.clock.now();
    await changeWallet(this.unit, uuidOf('accountId', input.accountId), now, (wallet) =>
      wallet.withdraw(asset, input.quantity, input.referenceId, now),
    );
  }
}

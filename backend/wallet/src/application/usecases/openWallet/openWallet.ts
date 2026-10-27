import { uuidOf } from '../../../domain/valueObjects.js';
import { Wallet } from '../../../domain/wallet.js';
import type { Clock } from '../../ports/system.js';
import type { WalletRepository } from '../../ports/walletPorts.js';
import type { UseCase } from '../../useCase.js';
import type { OpenWalletInput } from './openWalletInput.js';
import type { OpenWalletOutput } from './openWalletOutput.js';

export class OpenWallet implements UseCase<OpenWalletInput, OpenWalletOutput> {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    const accountId = uuidOf('accountId', input.accountId);
    if (await this.walletRepository.findByAccount(accountId)) return;
    await this.walletRepository.save(Wallet.open(accountId, this.clock.now()));
  }
}

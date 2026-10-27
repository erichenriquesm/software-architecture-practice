import type { ProjectWalletBalance } from '../../../../application/usecases/projectWalletBalance/projectWalletBalance.js';
import type { ProjectWalletBalanceInput } from '../../../../application/usecases/projectWalletBalance/projectWalletBalanceInput.js';
import type { FailureKind, MessageHandler } from '../../../platform/messaging/consumer.js';
import type { SchemaValidator } from '../../../platform/messaging/schemas.js';
import { ContractViolationError, loadSchemaValidator } from '../../../platform/messaging/schemas.js';
import type { ConsumerQueue } from '../../../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../../../platform/observability/correlation.js';

export const walletBalancesQueue: ConsumerQueue = {
  queue: 'account.walletBalances',
  bindings: [{ exchange: 'wallet.events', routingKey: 'wallet.balanceChanged' }],
  retryMode: 'delayQueues',
};

export const classifyWalletBalancesFailure = (error: unknown): FailureKind =>
  error instanceof ContractViolationError ? 'permanent' : 'transient';

export const walletBalancesHandler = (
  projectWalletBalance: ProjectWalletBalance,
  validatePayload: SchemaValidator<ProjectWalletBalanceInput> = loadSchemaValidator(
    'contracts/consumed/events/wallet.balanceChanged.v1.schema.json',
  ),
): MessageHandler => async (envelope) => {
  if (envelope.type !== 'wallet.balanceChanged' || envelope.version !== 1) {
    throw new ContractViolationError('wallet.balanceChanged', `unexpected ${envelope.type} v${envelope.version}`);
  }
  const projectWalletBalanceInput = validatePayload(envelope.payload);
  await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () =>
    projectWalletBalance.execute(projectWalletBalanceInput),
  );
};

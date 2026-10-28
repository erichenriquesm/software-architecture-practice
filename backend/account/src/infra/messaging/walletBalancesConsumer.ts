import type { ProjectWalletBalance } from '../../application/usecases/projectWalletBalance.js';
import type { BalanceChange } from '../../application/dtos/balanceView.js';
import type { FailureKind, MessageHandler } from '../platform/messaging/consumer.js';
import type { SchemaValidator } from '../platform/messaging/schemas.js';
import { ContractViolationError, loadSchemaValidator } from '../platform/messaging/schemas.js';
import type { ConsumerQueue } from '../platform/messaging/topology.js';
import { correlationFrom, withCorrelation } from '../platform/observability/correlation.js';

export const walletBalancesQueue: ConsumerQueue = {
  queue: 'account.walletBalances',
  bindings: [{ exchange: 'wallet.events', routingKey: 'wallet.balanceChanged' }],
  retryMode: 'delayQueues',
};

export const classifyWalletBalancesFailure = (error: unknown): FailureKind =>
  error instanceof ContractViolationError ? 'permanent' : 'transient';

export const walletBalancesHandler = (
  projectWalletBalance: ProjectWalletBalance,
  validatePayload: SchemaValidator<BalanceChange> = loadSchemaValidator(
    'src/infra/contracts/consumed/events/wallet.balanceChanged.v1.schema.json',
  ),
): MessageHandler => async (envelope) => {
  if (envelope.type !== 'wallet.balanceChanged' || envelope.version !== 1) {
    throw new ContractViolationError('wallet.balanceChanged', `unexpected ${envelope.type} v${envelope.version}`);
  }
  const balanceChange = validatePayload(envelope.payload);
  await withCorrelation(correlationFrom(envelope.correlationId, envelope.eventId), () =>
    projectWalletBalance.execute(balanceChange),
  );
};

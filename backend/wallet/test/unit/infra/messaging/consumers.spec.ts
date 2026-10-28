import { describe, expect, test } from 'vitest';
import { InsufficientFundsError, ReservationNotFoundError } from '../../../../src/domain/errors.js';
import { AccountServiceUnavailableError } from '../../../../src/infra/grpc/account/grpcAccountGateway.js';
import { classifyWalletFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { tradeExecutedUnits } from '../../../../src/infra/messaging/consumers/tradeExecutedConsumer.js';
import { createEnvelope } from '../../../../src/infra/platform/messaging/envelope.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

const ids = {
  tradeId: '0199d5f4-2b9a-7c3e-9a51-00000000000a',
  buyOrderId: '0199d5f4-2b9a-7c3e-9a51-000000000001',
  sellOrderId: '0199d5f4-2b9a-7c3e-9a51-000000000002',
  buyAccountId: '0199d5f4-2b9a-7c3e-9a51-0000000000b1',
  sellAccountId: '0199d5f4-2b9a-7c3e-9a51-0000000000c1',
};

const tradeEnvelope = (payload: Record<string, unknown>) =>
  createEnvelope({ type: 'matching.tradeExecuted', version: 1, producer: 'matching', correlationId: '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69', payload });

describe('tradeExecuted consumer', () => {
  test('Should split one trade into a buyer and a seller transaction, each with its own inbox key', () => {
    // Given
    const envelope = tradeEnvelope({
      ...ids,
      marketId: 'BTC-USD',
      side: 'sell',
      quantity: '5',
      price: '83000',
      executedAt: '2026-10-28T12:00:00.000Z',
      bookSequence: 1,
    });

    // When
    const units = tradeExecutedUnits(envelope);

    // Then
    expect(units).toEqual([
      { key: `${envelope.eventId}:${ids.buyAccountId}:buyer`, part: 'buyer' },
      { key: `${envelope.eventId}:${ids.sellAccountId}:seller`, part: 'seller' },
    ]);
  });

  test('Should refuse a payload outside the contract', () => {
    // When & Then
    expect(() => tradeExecutedUnits(tradeEnvelope({ ...ids }))).toThrowError(ContractViolationError);
  });
});

describe('classifyWalletFailure', () => {
  test.each([
    [new ContractViolationError('x', 'y'), 'permanent'],
    [new ReservationNotFoundError('o'), 'permanent'],
    [new AccountServiceUnavailableError(new Error('down')), 'transient'],
    [new InsufficientFundsError('USD'), 'transient'],
    [new Error('connection reset'), 'transient'],
  ])('Should classify %s as %s', (error, kind) => {
    // When & Then
    expect(classifyWalletFailure(error)).toBe(kind);
  });
});

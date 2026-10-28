import { describe, expect, test } from 'vitest';
import { FillExceedsQuantityError } from '../../../../src/domain/errors.js';
import { averagePrice } from '../../../../src/infra/database/orderViewProjector.js';
import { classifyOrderFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { matchingResultsUnits } from '../../../../src/infra/messaging/consumers/matchingResultsConsumer.js';
import { createEnvelope } from '../../../../src/infra/platform/messaging/envelope.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

const ids = {
  tradeId: '0199d5f4-2b9a-7c3e-9a51-00000000000a',
  buyOrderId: '0199d5f4-2b9a-7c3e-9a51-000000000001',
  sellOrderId: '0199d5f4-2b9a-7c3e-9a51-000000000002',
  buyAccountId: '0199d5f4-2b9a-7c3e-9a51-0000000000b1',
  sellAccountId: '0199d5f4-2b9a-7c3e-9a51-0000000000c1',
};
const envelopeOf = (type: string, payload: Record<string, unknown>) =>
  createEnvelope({ type, version: 1, producer: 'matching', correlationId: '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69', payload });

describe('order.matchingResults consumer', () => {
  test('Should split a trade into one transaction per order, keyed eventId:orderId', () => {
    // Given
    const envelope = envelopeOf('matching.tradeExecuted', {
      ...ids,
      marketId: 'BTC-USD',
      side: 'buy',
      quantity: '1',
      price: '100',
      executedAt: '2026-10-28T12:00:00.000Z',
      bookSequence: 3,
    });

    // When & Then
    expect(matchingResultsUnits(envelope)).toEqual([
      { key: `${envelope.eventId}:${ids.buyOrderId}`, part: ids.buyOrderId },
      { key: `${envelope.eventId}:${ids.sellOrderId}`, part: ids.sellOrderId },
    ]);
  });

  test('Should keep removals and cancel rejections as one transaction', () => {
    // Given
    const envelope = envelopeOf('matching.orderCancelRejected', { orderId: ids.buyOrderId, marketId: 'BTC-USD', reason: 'NOT_IN_BOOK' });

    // When & Then
    expect(matchingResultsUnits(envelope)).toEqual([{ key: envelope.eventId, part: null }]);
  });

  test('Should send contract violations and broken invariants to the DLQ, and retry the rest', () => {
    // When & Then
    expect(classifyOrderFailure(new ContractViolationError('x', 'y'))).toBe('permanent');
    expect(classifyOrderFailure(new FillExceedsQuantityError('o'))).toBe('permanent');
    expect(classifyOrderFailure(new Error('connection reset'))).toBe('transient');
  });
});

describe('Average fill price (read model only)', () => {
  test('Should round half-even to 8 places and be null without fills', () => {
    // When & Then
    expect(averagePrice('302', '3')).toBe('100.66666667');
    expect(averagePrice('0', '0')).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MarketNotFoundError } from '../../../../src/application/errors.js';
import { classifyMarketDataFailure, consumedEvent } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { createEnvelope, InvalidEnvelopeError } from '../../../../src/infra/platform/messaging/envelope.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

const envelopeOf = (type: string, payload: Record<string, unknown>) =>
  createEnvelope({ type, version: 1, producer: 'matching', correlationId: randomUUID(), payload });

const snapshot = { marketId: 'BTC-USD', sequence: 3, bids: [{ price: '84000.5', quantity: '1.25' }], asks: [] };

describe('Inbound ACL of the matching events', () => {
  test('Should accept a bookSnapshot that follows our copy of the contract', () => {
    // When & Then
    expect(consumedEvent('matching.bookSnapshot')(envelopeOf('matching.bookSnapshot', snapshot))).toEqual(snapshot);
  });

  test.each([
    ['a sequence of zero', { ...snapshot, sequence: 0 }],
    ['a price with more than 8 decimals', { ...snapshot, bids: [{ price: '1.123456789', quantity: '1' }] }],
    ['a numeric quantity', { ...snapshot, asks: [{ price: '1', quantity: 1 }] }],
    ['a field the contract does not have', { ...snapshot, delta: true }],
  ])('Should refuse a bookSnapshot with %s', (_case, payload) => {
    // When & Then
    expect(() => consumedEvent('matching.bookSnapshot')(envelopeOf('matching.bookSnapshot', payload))).toThrowError(ContractViolationError);
  });

  test('Should refuse an event of another type or version', () => {
    // Given
    const envelope = { ...envelopeOf('matching.bookSnapshot', snapshot), version: 2 };

    // When & Then
    expect(() => consumedEvent('matching.bookSnapshot')(envelope)).toThrowError(ContractViolationError);
    expect(() => consumedEvent('matching.tradeExecuted')(envelopeOf('matching.bookSnapshot', snapshot))).toThrowError(ContractViolationError);
  });
});

describe('classifyMarketDataFailure', () => {
  test.each([
    ['a contract violation', new ContractViolationError('x', 'y')],
    ['a malformed envelope', new InvalidEnvelopeError('y')],
    ['a market outside the catalog', new MarketNotFoundError('ETH-USD')],
  ])('Should send %s straight to the DLQ', (_case, error) => {
    // When & Then
    expect(classifyMarketDataFailure(error)).toBe('permanent');
  });

  test('Should retry anything else, such as the database being down', () => {
    // When & Then
    expect(classifyMarketDataFailure(new Error('connection refused'))).toBe('transient');
  });
});

import { describe, expect, test } from 'vitest';
import { ConcurrentBookUpdateError, InvalidBookDataError } from '../../../../src/domain/errors.js';
import { classifyMatchingFailure } from '../../../../src/infra/messaging/consumers/consumedEvent.js';
import { marketOrdersQueue } from '../../../../src/infra/messaging/consumers/marketOrdersConsumer.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

describe('matching.orders.<market> queue', () => {
  test('Should put accepts and cancels of one market in one ordered queue with a single active consumer and in-process retry', () => {
    // When & Then
    expect(marketOrdersQueue('BTC-USD')).toEqual({
      queue: 'matching.orders.BTC-USD',
      bindings: [
        { exchange: 'order.events', routingKey: 'order.accepted.BTC-USD' },
        { exchange: 'order.events', routingKey: 'order.cancelRequested.BTC-USD' },
      ],
      retryMode: 'inProcess',
      singleActiveConsumer: true,
    });
  });

  test('Should send bad payloads to the DLQ and retry everything else in process', () => {
    // When & Then
    expect(classifyMatchingFailure(new ContractViolationError('x', 'y'))).toBe('permanent');
    expect(classifyMatchingFailure(new InvalidBookDataError('price', 'bad'))).toBe('permanent');
    expect(classifyMatchingFailure(new ConcurrentBookUpdateError('BTC-USD'))).toBe('transient');
  });
});

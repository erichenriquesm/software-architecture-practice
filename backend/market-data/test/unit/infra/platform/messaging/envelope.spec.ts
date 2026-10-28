import { describe, expect, test } from 'vitest';
import { createEnvelope, InvalidEnvelopeError, loadEnvelopeValidator } from '../../../../../src/infra/platform/messaging/envelope.js';

const validate = loadEnvelopeValidator();
const correlationId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';

describe('Envelope', () => {
  test('Should create a valid envelope with a v7 id, ISO time and null causation by default', () => {
    // Given
    const now = () => new Date('2026-10-27T12:00:00.000Z');

    // When
    const envelope = createEnvelope(
      { type: 'account.created', version: 1, producer: 'account', correlationId, payload: { accountId: 'a-1' } },
      now,
    );

    // Then
    expect(validate(envelope)).toBe(envelope);
    expect(envelope.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(envelope.occurredAt).toBe('2026-10-27T12:00:00.000Z');
    expect(envelope.causationId).toBeNull();
  });

  test.each([
    ['an unknown producer', { producer: 'billing' }],
    ['a type outside <context>.<fact>', { type: 'AccountCreated' }],
    ['an extra field', { extra: true }],
    ['a non-uuid correlation id', { correlationId: 'abc' }],
  ])('Should reject an envelope with %s', (_case, change) => {
    // Given
    const envelope = {
      ...createEnvelope({ type: 'account.created', version: 1, producer: 'account', correlationId, payload: {} }),
      ...change,
    };

    // When & Then
    expect(() => validate(envelope)).toThrowError(InvalidEnvelopeError);
  });
});

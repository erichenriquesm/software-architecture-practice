import { randomUUID } from 'node:crypto';
import type { BookSnapshot } from '../../src/infra/database/bookProjector.js';
import type { ExecutedTrade } from '../../src/infra/database/tradeProjector.js';
import type { Envelope } from '../../src/infra/platform/messaging/envelope.js';
import { createEnvelope } from '../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../src/infra/platform/messaging/schemas.js';

const consumed = (type: string) => loadSchemaValidator<Record<string, unknown>>(`src/infra/contracts/consumed/events/${type}.v1.schema.json`);
const tradeContract = consumed('matching.tradeExecuted');
const snapshotContract = consumed('matching.bookSnapshot');

export type TradePayload = ExecutedTrade & { readonly buyAccountId: string; readonly sellAccountId: string; readonly bookSequence: number };

/** A matching.tradeExecuted payload checked against our copy of the contract, so a fixture never lies about it. */
export const tradeFixture = (overrides: Partial<TradePayload> = {}): TradePayload => {
  const payload: TradePayload = {
    tradeId: randomUUID(),
    marketId: 'BTC-USD',
    buyOrderId: randomUUID(),
    sellOrderId: randomUUID(),
    buyAccountId: randomUUID(),
    sellAccountId: randomUUID(),
    side: 'sell',
    quantity: '1',
    price: '84000',
    executedAt: '2026-10-28T10:00:00.000Z',
    bookSequence: 1,
    ...overrides,
  };
  tradeContract(payload);
  return payload;
};

export const snapshotFixture = (overrides: Partial<BookSnapshot> = {}): BookSnapshot => {
  const payload: BookSnapshot = { marketId: 'BTC-USD', sequence: 1, bids: [], asks: [], ...overrides };
  snapshotContract(payload);
  return payload;
};

export const matchingEnvelope = (type: string, payload: object, occurredAt = new Date('2026-10-28T10:00:00.000Z')): Envelope =>
  createEnvelope({ type, version: 1, producer: 'matching', correlationId: randomUUID(), payload: payload as Record<string, unknown> }, () => occurredAt);

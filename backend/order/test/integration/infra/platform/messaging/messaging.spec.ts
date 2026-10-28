import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../../../support/database.js';
import { createTestDatabase } from '../../../../support/database.js';
import type { TestBroker } from '../../../../support/rabbitmq.js';
import { createTestBroker } from '../../../../support/rabbitmq.js';
import type { Envelope } from '../../../../../src/infra/platform/messaging/envelope.js';
import { createEnvelope, loadEnvelopeValidator } from '../../../../../src/infra/platform/messaging/envelope.js';
import type { FailureKind } from '../../../../../src/infra/platform/messaging/consumer.js';
import { Consumer } from '../../../../../src/infra/platform/messaging/consumer.js';
import { KyselyTransactionRunner } from '../../../../../src/infra/database/kyselyTransactionRunner.js';
import { appendToOutbox, OutboxRelay } from '../../../../../src/infra/platform/messaging/outbox.js';
import type { ConsumerQueue } from '../../../../../src/infra/platform/messaging/topology.js';
import { deadLetterQueue, declareConsumerQueue } from '../../../../../src/infra/platform/messaging/topology.js';

class TransientFailure extends Error {}
class PermanentFailure extends Error {}

const classify = (error: unknown): FailureKind => (error instanceof TransientFailure ? 'transient' : 'permanent');
const validate = loadEnvelopeValidator();
const correlationId = '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69';
const fastTiers = [
  { name: 'a', delayMs: 100 },
  { name: 'b', delayMs: 200 },
  { name: 'c', delayMs: 300 },
];

const envelopeOf = (payload: Record<string, unknown> = {}): Envelope =>
  createEnvelope({ type: 'account.created', version: 1, producer: 'account', correlationId, payload });

let database: TestDatabase;
let broker: TestBroker;
const consumers: Consumer[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  broker = await createTestBroker();
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()));
});

afterAll(async () => {
  await broker.close();
  await database.destroy();
});

const queueBoundToTestExchange = async (routingKey: string): Promise<ConsumerQueue> => {
  const definition: ConsumerQueue = {
    queue: broker.uniqueName('test.queue'),
    bindings: [{ exchange: broker.exchange, routingKey }],
    retryMode: 'delayQueues',
    retryTiers: fastTiers,
  };
  await declareConsumerQueue(broker.channel, definition);
  return definition;
};

const startConsumer = async (definition: ConsumerQueue, handler: (envelope: Envelope) => Promise<void>) => {
  const channel = await broker.connection.createChannel();
  const consumer = new Consumer(new KyselyTransactionRunner(database.db), channel, { definition, handler, validate, classify });
  await consumer.start();
  consumers.push(consumer);
};

const waitUntil = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('Outbox relay', () => {
  test('Should publish pending events in insertion order with confirms and mark them as published', async () => {
    // Given
    const definition = await queueBoundToTestExchange('ordered.#');
    const envelopes = [envelopeOf({ position: 1 }), envelopeOf({ position: 2 }), envelopeOf({ position: 3 })];
    await database.db.transaction().execute(async (trx) => {
      for (const envelope of envelopes) await appendToOutbox(trx, { routingKey: 'ordered.event', envelope });
    });
    const relay = new OutboxRelay(database.db, await broker.connection.createConfirmChannel(), {
      exchange: broker.exchange,
      lockKey: 1001,
    });

    // When
    const published = await relay.publishPending();

    // Then
    expect(published).toBe(3);
    const received = [];
    for (let index = 0; index < 3; index += 1) received.push(JSON.parse((await broker.nextMessage(definition.queue)).content.toString()));
    expect(received.map((envelope) => envelope.payload.position)).toEqual([1, 2, 3]);
    const pending = await database.db.selectFrom('outbox').select('id').where('published_at', 'is', null).execute();
    expect(pending).toHaveLength(0);
  });
});

describe('Consumer', () => {
  test('Should process a duplicated event only once (inbox)', async () => {
    // Given
    const definition = await queueBoundToTestExchange('dup.#');
    const handled: string[] = [];
    await startConsumer(definition, async (envelope) => void handled.push(envelope.eventId));
    const envelope = envelopeOf();

    // When
    broker.channel.publish(broker.exchange, 'dup.event', Buffer.from(JSON.stringify(envelope)));
    broker.channel.publish(broker.exchange, 'dup.event', Buffer.from(JSON.stringify(envelope)));
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Then
    expect(handled).toEqual([envelope.eventId]);
  });

  test('Should retry a transient failure through every delay tier and then park it in the DLQ', async () => {
    // Given
    const definition = await queueBoundToTestExchange('transient.#');
    let attempts = 0;
    await startConsumer(definition, async () => {
      attempts += 1;
      throw new TransientFailure('database down');
    });

    // When
    broker.channel.publish(broker.exchange, 'transient.event', Buffer.from(JSON.stringify(envelopeOf())));
    const parked = await broker.nextMessage(deadLetterQueue(definition.queue));

    // Then
    expect(attempts).toBe(4);
    expect(parked.properties.headers?.['x-attempt']).toBe(4);
    expect(parked.properties.headers?.['x-error']).toBe('database down');
  });

  test('Should send a permanent failure straight to the DLQ without retrying', async () => {
    // Given
    const definition = await queueBoundToTestExchange('permanent.#');
    let attempts = 0;
    await startConsumer(definition, async () => {
      attempts += 1;
      throw new PermanentFailure('bug');
    });

    // When
    broker.channel.publish(broker.exchange, 'permanent.event', Buffer.from(JSON.stringify(envelopeOf())));
    const parked = await broker.nextMessage(deadLetterQueue(definition.queue));

    // Then
    expect(attempts).toBe(1);
    expect(parked.properties.headers?.['x-attempt']).toBe(1);
  });

  test('Should park a malformed message in the DLQ without calling the handler', async () => {
    // Given
    const definition = await queueBoundToTestExchange('malformed.#');
    let attempts = 0;
    await startConsumer(definition, async () => void (attempts += 1));

    // When
    broker.channel.publish(broker.exchange, 'malformed.event', Buffer.from('{"not":"an envelope"}'));
    await broker.nextMessage(deadLetterQueue(definition.queue));

    // Then
    expect(attempts).toBe(0);
  });

  test('Should apply the effect once when a transient failure recovers on retry', async () => {
    // Given
    const definition = await queueBoundToTestExchange('recover.#');
    let attempts = 0;
    let applied = 0;
    await startConsumer(definition, async () => {
      attempts += 1;
      if (attempts === 1) throw new TransientFailure('blip');
      applied += 1;
    });

    // When
    broker.channel.publish(broker.exchange, 'recover.event', Buffer.from(JSON.stringify(envelopeOf())));
    await waitUntil(() => applied === 1);

    // Then
    expect(attempts).toBe(2);
    const inbox = await database.db.selectFrom('inbox').selectAll().where('consumer', '=', definition.queue).execute();
    expect(inbox).toHaveLength(1);
  });
});

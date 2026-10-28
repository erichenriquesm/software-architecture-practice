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

const startConsumer = async (definition: ConsumerQueue, handler: (envelope: Envelope) => Promise<void>, inbox = true) => {
  const channel = await broker.connection.createChannel();
  const consumer = new Consumer(new KyselyTransactionRunner(database.db), channel, { definition, handler, validate, classify, inbox });
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

  test('Should hand every delivery to the handler and keep no inbox row when the inbox is off', async () => {
    // Given
    const definition = await queueBoundToTestExchange('noinbox.#');
    const handled: string[] = [];
    await startConsumer(definition, async (envelope) => void handled.push(envelope.eventId), false);
    const envelope = envelopeOf();

    // When
    broker.channel.publish(broker.exchange, 'noinbox.event', Buffer.from(JSON.stringify(envelope)));
    broker.channel.publish(broker.exchange, 'noinbox.event', Buffer.from(JSON.stringify(envelope)));
    await waitUntil(() => handled.length === 2);

    // Then
    expect(handled).toEqual([envelope.eventId, envelope.eventId]);
    const inbox = await database.db.selectFrom('inbox').selectAll().where('consumer', '=', definition.queue).execute();
    expect(inbox).toHaveLength(0);
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

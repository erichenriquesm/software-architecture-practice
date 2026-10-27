import { randomUUID } from 'node:crypto';
import type { AmqpConnection } from '../../src/infra/platform/messaging/connection.js';
import { connectRabbitMq } from '../../src/infra/platform/messaging/connection.js';
import { retryExchange } from '../../src/infra/platform/messaging/topology.js';

type Channel = Awaited<ReturnType<AmqpConnection['createChannel']>>;
type Message = Exclude<Awaited<ReturnType<Channel['get']>>, false>;

export interface TestBroker {
  readonly connection: AmqpConnection;
  readonly channel: Channel;
  readonly exchange: string;
  uniqueName(prefix: string): string;
  nextMessage(queue: string, timeoutMs?: number): Promise<Message>;
  close(): Promise<void>;
}

export const createTestBroker = async (): Promise<TestBroker> => {
  const connection = await connectRabbitMq(process.env.TEST_RABBITMQ_URL ?? 'amqp://test:test@localhost:5672');
  const channel = await connection.createChannel();
  const exchange = `test.events.${randomUUID().slice(0, 8)}`;
  await channel.assertExchange(retryExchange, 'direct', { durable: true });
  await channel.assertExchange(exchange, 'topic', { durable: false, autoDelete: true });

  const nextMessage = async (queue: string, timeoutMs = 10_000): Promise<Message> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await channel.get(queue, { noAck: true });
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No message on ${queue} within ${timeoutMs} ms`);
  };

  return {
    connection,
    channel,
    exchange,
    uniqueName: (prefix) => `${prefix}.${randomUUID().slice(0, 8)}`,
    nextMessage,
    close: async () => connection.close(),
  };
};

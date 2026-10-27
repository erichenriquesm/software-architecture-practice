import type { AmqpConnection } from './connection.js';

type Channel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

export const retryExchange = 'retry';

export interface QueueBinding {
  readonly exchange: string;
  readonly routingKey: string;
}

export interface RetryTier {
  readonly name: string;
  readonly delayMs: number;
}

export const defaultRetryTiers: readonly RetryTier[] = [
  { name: '1s', delayMs: 1_000 },
  { name: '5s', delayMs: 5_000 },
  { name: '25s', delayMs: 25_000 },
];

export interface ConsumerQueue {
  readonly queue: string;
  readonly bindings: readonly QueueBinding[];
  readonly retryMode: 'delayQueues' | 'inProcess';
  readonly singleActiveConsumer?: boolean;
  readonly retryTiers?: readonly RetryTier[];
}

export const tierRoutingKey = (queue: string, tier: RetryTier): string => `${queue}.retry.${tier.name}`;
export const deadLetterQueue = (queue: string): string => `${queue}.dlq`;

const quorum = { 'x-queue-type': 'quorum' };

export const declareConsumerQueue = async (channel: Channel, definition: ConsumerQueue): Promise<void> => {
  const { queue } = definition;
  const mainArguments = definition.singleActiveConsumer ? { ...quorum, 'x-single-active-consumer': true } : quorum;
  await channel.assertQueue(queue, { durable: true, arguments: mainArguments });
  await channel.bindQueue(queue, retryExchange, queue);
  await Promise.all(definition.bindings.map((binding) => channel.bindQueue(queue, binding.exchange, binding.routingKey)));

  await channel.assertQueue(deadLetterQueue(queue), { durable: true, arguments: quorum });
  await channel.bindQueue(deadLetterQueue(queue), retryExchange, deadLetterQueue(queue));

  if (definition.retryMode === 'inProcess') return;
  for (const tier of definition.retryTiers ?? defaultRetryTiers) {
    await channel.assertQueue(tierRoutingKey(queue, tier), {
      durable: true,
      arguments: {
        ...quorum,
        'x-message-ttl': tier.delayMs,
        'x-dead-letter-exchange': retryExchange,
        'x-dead-letter-routing-key': queue,
      },
    });
    await channel.bindQueue(tierRoutingKey(queue, tier), retryExchange, tierRoutingKey(queue, tier));
  }
};

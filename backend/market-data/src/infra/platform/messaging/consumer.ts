import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../adapters/outbound/persistence/database.js';
import type { RetryPolicy } from '../resilience/retry.js';
import { retry } from '../resilience/retry.js';
import type { AmqpConnection } from './connection.js';
import type { Envelope, EnvelopeValidator } from './envelope.js';
import { InvalidEnvelopeError } from './envelope.js';
import type { ConsumerQueue, RetryTier } from './topology.js';
import { deadLetterQueue, defaultRetryTiers, retryExchange, tierRoutingKey } from './topology.js';

type Channel = Awaited<ReturnType<AmqpConnection['createChannel']>>;
type Message = NonNullable<Parameters<Parameters<Channel['consume']>[1]>[0]>;

export type FailureKind = 'transient' | 'permanent';

export type MessageHandler = (envelope: Envelope, trx: Transaction<Database>) => Promise<void>;

export interface ConsumerOptions {
  readonly definition: ConsumerQueue;
  readonly handler: MessageHandler;
  readonly validate: EnvelopeValidator;
  readonly classify: (error: unknown) => FailureKind;
  readonly inProcessRetry?: RetryPolicy;
  readonly prefetch?: number;
}

const attemptOf = (message: Message): number => Number(message.properties.headers?.['x-attempt'] ?? 0);

const isMalformed = (error: unknown): boolean => error instanceof InvalidEnvelopeError || error instanceof SyntaxError;

export const markProcessed = async (trx: Transaction<Database>, consumer: string, messageKey: string): Promise<boolean> => {
  const result = await trx
    .insertInto('inbox')
    .values({ consumer, message_key: messageKey })
    .onConflict((conflict) => conflict.columns(['consumer', 'message_key']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
};

export class Consumer {
  private consumerTag: string | undefined;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly channel: Channel,
    private readonly options: ConsumerOptions,
  ) {}

  private get queue(): string {
    return this.options.definition.queue;
  }

  private get tiers(): readonly RetryTier[] {
    return this.options.definition.retryTiers ?? defaultRetryTiers;
  }

  async start(): Promise<void> {
    await this.channel.prefetch(this.options.prefetch ?? (this.options.definition.retryMode === 'inProcess' ? 1 : 10));
    const consumed = await this.channel.consume(this.queue, (message) => {
      if (message) void this.onMessage(message);
    });
    this.consumerTag = consumed.consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.channel.cancel(this.consumerTag);
  }

  private async onMessage(message: Message): Promise<void> {
    try {
      await this.process(message);
      this.channel.ack(message);
    } catch (error) {
      await this.onFailure(message, error);
    }
  }

  private async process(message: Message): Promise<void> {
    const envelope = this.options.validate(JSON.parse(message.content.toString()));
    const run = () =>
      this.db.transaction().execute(async (trx) => {
        const firstTime = await markProcessed(trx, this.queue, envelope.eventId);
        if (firstTime) await this.options.handler(envelope, trx);
      });
    if (this.options.definition.retryMode !== 'inProcess') return run();
    return retry(run, this.options.inProcessRetry ?? { baseMs: 200, capMs: 10_000, maxAttempts: Infinity }, {
      isTransient: (error) => this.options.classify(error) === 'transient',
    });
  }

  private async onFailure(message: Message, error: unknown): Promise<void> {
    const attempt = attemptOf(message);
    const transient = !isMalformed(error) && this.options.classify(error) === 'transient';
    const tier = this.tiers[attempt];
    const delayed = transient && this.options.definition.retryMode === 'delayQueues' && tier !== undefined;
    const routingKey = delayed ? tierRoutingKey(this.queue, tier) : deadLetterQueue(this.queue);

    this.channel.publish(retryExchange, routingKey, message.content, {
      persistent: true,
      contentType: 'application/json',
      headers: {
        ...message.properties.headers,
        'x-attempt': attempt + 1,
        ...(delayed ? {} : { 'x-error': String(error instanceof Error ? error.message : error), 'x-failed-at': new Date().toISOString() }),
      },
    });
    this.channel.ack(message);
  }
}

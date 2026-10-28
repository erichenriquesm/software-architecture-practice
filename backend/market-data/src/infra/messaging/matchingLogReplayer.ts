import type { Kysely } from 'kysely';
import type { Database } from '../database/database.js';
import { truncateProjections } from '../database/projections.js';
import type { AmqpConnection } from '../platform/messaging/connection.js';
import type { FailureKind, MessageHandler } from '../platform/messaging/consumer.js';
import type { EnvelopeValidator } from '../platform/messaging/envelope.js';

type Channel = Awaited<ReturnType<AmqpConnection['createChannel']>>;
type Message = NonNullable<Parameters<Parameters<Channel['consume']>[1]>[0]>;

export interface ReplayOptions {
  readonly stream: string;
  readonly handler: MessageHandler;
  readonly validate: EnvelopeValidator;
  readonly classify: (error: unknown) => FailureKind;
  /** AMQP 0.9.1 cannot tell a stream consumer where the end is: being idle this long means it was reached. */
  readonly idleTimeoutMs: number;
  readonly prefetch?: number;
}

export interface ReplayResult {
  readonly applied: number;
  readonly skipped: number;
}

/**
 * Rebuilds every projection: empties the *_view tables and applies the stream from its first offset with the same
 * projectors, without inbox (the projections are idempotent by tradeId and last-write-wins by sequence).
 */
export class MatchingLogReplayer {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly channel: Channel,
    private readonly options: ReplayOptions,
  ) {}

  async rebuild(): Promise<ReplayResult> {
    await truncateProjections(this.db);
    return this.replay();
  }

  private async apply(message: Message): Promise<'applied' | 'skipped'> {
    try {
      const envelope = this.options.validate(JSON.parse(message.content.toString()));
      await this.db.transaction().execute((trx) => this.options.handler(envelope, trx, null));
      return 'applied';
    } catch (error) {
      if (this.options.classify(error) === 'transient') throw error;
      return 'skipped';
    }
  }

  private async replay(): Promise<ReplayResult> {
    await this.channel.prefetch(this.options.prefetch ?? 100);
    const counts = { applied: 0, skipped: 0 };
    let chain = Promise.resolve();
    let consumerTag: string | undefined;
    let timer: NodeJS.Timeout | undefined;

    return new Promise<ReplayResult>((resolve, reject) => {
      const fail = (error: unknown): void => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const finish = async (): Promise<void> => {
        if (consumerTag) await this.channel.cancel(consumerTag);
        await chain;
        resolve(counts);
      };
      const armIdleTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => void finish().catch(fail), this.options.idleTimeoutMs);
      };
      const onMessage = (message: Message): void => {
        armIdleTimer();
        chain = chain
          .then(() => this.apply(message))
          .then((outcome) => {
            counts[outcome] += 1;
            this.channel.ack(message);
            armIdleTimer();
          })
          .catch(fail);
      };
      this.channel
        .consume(this.options.stream, (message) => message && onMessage(message), { noAck: false, arguments: { 'x-stream-offset': 'first' } })
        .then((consumed) => {
          consumerTag = consumed.consumerTag;
          armIdleTimer();
        }, fail);
    });
  }
}

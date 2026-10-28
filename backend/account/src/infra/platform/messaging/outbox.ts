import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../database/database.js';
import type { AmqpConnection } from './connection.js';
import type { Envelope } from './envelope.js';

type ConfirmChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>;

export interface OutboxMessage {
  readonly routingKey: string;
  readonly envelope: Envelope<unknown>;
}

export const appendToOutbox = async (trx: Transaction<Database>, message: OutboxMessage): Promise<void> => {
  await trx
    .insertInto('outbox')
    .values({
      event_id: message.envelope.eventId,
      type: message.envelope.type,
      routing_key: message.routingKey,
      envelope: JSON.stringify(message.envelope),
    })
    .execute();
};

const publishConfirmed = (channel: ConfirmChannel, exchange: string, routingKey: string, body: string, messageId: string) =>
  new Promise<void>((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      Buffer.from(body),
      { persistent: true, contentType: 'application/json', messageId },
      (error) => (error ? reject(error) : resolve()),
    );
  });

export interface OutboxRelayOptions {
  readonly exchange: string;
  readonly lockKey: number;
  readonly batchSize?: number;
  readonly intervalMs?: number;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly channel: ConfirmChannel,
    private readonly options: OutboxRelayOptions,
  ) {}

  async publishPending(): Promise<number> {
    return this.db.connection().execute(async (connection) => {
      const lock = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${this.options.lockKey}) as locked`.execute(connection);
      if (!lock.rows[0]?.locked) return 0;
      try {
        return await this.publishBatch(connection);
      } finally {
        await sql`select pg_advisory_unlock(${this.options.lockKey})`.execute(connection);
      }
    });
  }

  private async publishBatch(connection: Kysely<Database>): Promise<number> {
    return connection.transaction().execute(async (trx) => {
      const pending = await trx
        .selectFrom('outbox')
        .select(['id', 'event_id', 'routing_key', 'envelope'])
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(this.options.batchSize ?? 100)
        .forUpdate()
        .skipLocked()
        .execute();

      for (const row of pending) {
        await publishConfirmed(this.channel, this.options.exchange, row.routing_key, JSON.stringify(row.envelope), row.event_id);
        await trx.updateTable('outbox').set({ published_at: new Date() }).where('id', '=', row.id).execute();
      }
      return pending.length;
    });
  }

  start(): void {
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      await this.publishPending().finally(() => (this.running = false));
    };
    this.timer = setInterval(() => void tick().catch(() => undefined), this.options.intervalMs ?? 200);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

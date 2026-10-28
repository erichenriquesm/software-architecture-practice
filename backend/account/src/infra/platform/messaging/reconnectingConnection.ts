import type { RetryPolicy } from '../resilience/retry.js';
import { fullJitterDelay } from '../resilience/retry.js';
import type { AmqpConnection } from './connection.js';

/** What the worker builds on top of a connection (relay, consumers); returns how to tear it down. */
export type ConnectionSetup = (connection: AmqpConnection) => Promise<() => Promise<void>>;

export interface ReconnectingConnectionOptions {
  readonly connect: () => Promise<AmqpConnection>;
  readonly setup: ConnectionSetup;
  readonly policy?: RetryPolicy;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onEvent?: (event: 'connected' | 'lost' | 'retrying', detail?: unknown) => void;
}

const brokerReconnectPolicy: RetryPolicy = { baseMs: 500, capMs: 30_000, maxAttempts: Number.POSITIVE_INFINITY };
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps the worker attached to RabbitMQ: connects with exponential backoff + full jitter and no attempt limit,
 * and when the connection drops it tears down the relay and consumers and builds them again on a new connection.
 * While disconnected the outbox only accumulates; nothing is lost.
 */
export class ReconnectingConnection {
  private connection: AmqpConnection | undefined;
  private teardown: (() => Promise<void>) | undefined;
  private stopped = false;

  constructor(private readonly options: ReconnectingConnectionOptions) {}

  isConnected(): boolean {
    return this.connection !== undefined;
  }

  /** Resolves once the first connection is up and set up. */
  async start(): Promise<void> {
    for (let attempt = 1; !this.stopped; attempt += 1) {
      if (await this.tryConnect()) return;
      this.options.onEvent?.('retrying', attempt);
      await (this.options.sleep ?? defaultSleep)(this.delay(attempt));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.release();
  }

  private async tryConnect(): Promise<boolean> {
    try {
      const connection = await this.options.connect();
      connection.on('error', () => undefined);
      connection.once('close', () => void this.onLost());
      this.teardown = await this.options.setup(connection);
      this.connection = connection;
      this.options.onEvent?.('connected');
      return true;
    } catch (error) {
      this.options.onEvent?.('lost', error);
      await this.release();
      return false;
    }
  }

  private async onLost(): Promise<void> {
    if (!this.connection) return;
    this.connection = undefined;
    this.options.onEvent?.('lost');
    await this.runTeardown();
    if (!this.stopped) await this.start();
  }

  private async release(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await this.runTeardown();
    await connection?.close().catch(() => undefined);
  }

  private async runTeardown(): Promise<void> {
    const teardown = this.teardown;
    this.teardown = undefined;
    await teardown?.().catch(() => undefined);
  }

  private delay(attempt: number): number {
    return fullJitterDelay(this.options.policy ?? brokerReconnectPolicy, attempt, this.options.random ?? Math.random);
  }
}

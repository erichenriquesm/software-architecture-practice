import type { Clock } from '../../application/contracts/clock.js';
import type { OrderDao } from '../../application/contracts/orderDao.js';
import type { ExpireOrder } from '../../application/usecases/expireOrder.js';

export interface ExpirePendingOrdersOptions {
  readonly orderDao: OrderDao;
  readonly expireOrder: ExpireOrder;
  readonly clock: Clock;
  readonly pendingTimeoutMs: number;
  readonly intervalMs: number;
  readonly onError?: (orderId: string, error: unknown) => void;
}

/** Saga S2 owner timeout: lists the pending orders past the timeout and expires them one by one. */
export class ExpirePendingOrders {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: ExpirePendingOrdersOptions) {}

  async runOnce(): Promise<number> {
    const cutoff = new Date(this.options.clock.now().getTime() - this.options.pendingTimeoutMs);
    const orderIds = await this.options.orderDao.listPendingCreatedBefore(cutoff);
    for (const orderId of orderIds) {
      await this.options.expireOrder.execute(orderId).catch((error: unknown) => this.options.onError?.(orderId, error));
    }
    return orderIds.length;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.runOnce()
      .catch(() => undefined)
      .finally(() => (this.running = false));
  }
}

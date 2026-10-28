import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../support/database.js';
import { createTestDatabase } from '../../support/database.js';
import { fixedClock } from '../../fakes/fixedSystem.js';
import { Order } from '../../../src/domain/entities/order.js';
import { AccountId } from '../../../src/domain/valueObjects/accountId.js';
import { MarketFilters } from '../../../src/domain/valueObjects/marketFilters.js';
import { MarketId } from '../../../src/domain/valueObjects/marketId.js';
import { OrderId } from '../../../src/domain/valueObjects/orderId.js';
import { Price } from '../../../src/domain/valueObjects/price.js';
import { Quantity } from '../../../src/domain/valueObjects/quantity.js';
import { Side } from '../../../src/domain/valueObjects/side.js';
import type { OrderCore } from '../../../src/infra/composition.js';
import { buildOrderApi, buildOrderCore } from '../../../src/infra/composition.js';
import { KyselyOrderRepository } from '../../../src/infra/database/kyselyOrderRepository.js';
import type { RateLimiter } from '../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { loadEnvelopeValidator } from '../../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../../src/infra/platform/messaging/schemas.js';
import { ExpirePendingOrders } from '../../../src/infra/scheduler/expirePendingOrders.js';

const unlimited: RateLimiter = {
  check: async (check) => ({ allowed: true, remaining: check.policy.limit, resetSeconds: 0, retryAfterSeconds: 0, policy: check.policy }),
};

let database: TestDatabase;
let app: FastifyInstance;
let core: OrderCore;

beforeAll(async () => {
  database = await createTestDatabase();
  ({ app, core } = buildOrderApi({ db: database.db, rateLimiter: unlimited }));
});

afterAll(async () => {
  await app.close();
  await database.destroy();
});

const placeOrder = (accountId: string, quantity = '0.01', price = '50000') =>
  app.inject({ method: 'POST', url: '/place_order', payload: { marketId: 'BTC-USD', accountId, side: 'buy', quantity, price } });

const outboxOf = async (orderId: string) =>
  database.db
    .selectFrom('outbox')
    .select(['routing_key', 'envelope'])
    .where(sql<string>`envelope->'payload'->>'orderId'`, '=', orderId)
    .orderBy('id')
    .execute();

describe('POST /place_order and the read model', () => {
  test('Should answer 202 pending, write order and order_view, and publish a valid order.placed', async () => {
    // Given
    const accountId = randomUUID();

    // When
    const response = await placeOrder(accountId);

    // Then
    expect(response.statusCode).toBe(202);
    const { orderId, status } = response.json();
    expect(status).toBe('pending');
    const view = await app.inject({ method: 'GET', url: `/orders/${orderId}` });
    expect(view.json()).toMatchObject({ orderId, accountId, status: 'pending', quantity: '0.01000000', fillQuantity: '0.00000000', fillPrice: null });
    const [placed] = await outboxOf(orderId);
    expect(placed?.routing_key).toBe('order.placed');
    const envelope = loadEnvelopeValidator()(placed?.envelope);
    expect(loadSchemaValidator('src/infra/contracts/published/events/order.placed.v1.schema.json')(envelope.payload)).toMatchObject({ orderId, accountId });
  });

  test('Should answer 422 for a price off the tick, 404 for an unknown order and filter the list by status', async () => {
    // Given
    const accountId = randomUUID();
    const { orderId } = (await placeOrder(accountId)).json();
    await placeOrder(accountId);
    await core.acceptOrder.execute(orderId);

    // When
    const offTick = await placeOrder(accountId, '0.01', '50000.001');
    const unknown = await app.inject({ method: 'GET', url: `/orders/${randomUUID()}` });
    const openOnly = await app.inject({ method: 'GET', url: `/accounts/${accountId}/orders?status=open` });
    const all = await app.inject({ method: 'GET', url: `/accounts/${accountId}/orders` });

    // Then
    expect([offTick.statusCode, unknown.statusCode]).toEqual([422, 404]);
    expect(openOnly.json().map((order: { orderId: string }) => order.orderId)).toEqual([orderId]);
    expect(all.json()).toHaveLength(2);
  });
});

describe('POST /cancel_order', () => {
  test('Should cancel a pending order at once (order.voided) and refuse another account with 403', async () => {
    // Given
    const accountId = randomUUID();
    const { orderId } = (await placeOrder(accountId)).json();

    // When
    const foreign = await app.inject({ method: 'POST', url: '/cancel_order', payload: { orderId, accountId: randomUUID() } });
    const own = await app.inject({ method: 'POST', url: '/cancel_order', payload: { orderId, accountId } });
    const again = await app.inject({ method: 'POST', url: '/cancel_order', payload: { orderId, accountId } });

    // Then
    expect([foreign.statusCode, own.statusCode, again.statusCode]).toEqual([403, 202, 409]);
    expect(own.json()).toEqual({ orderId, status: 'cancelled' });
    expect((await outboxOf(orderId)).map((row) => row.routing_key)).toEqual(['order.placed', 'order.voided']);
  });

  test('Should publish order.accepted before order.cancelRequested, both keyed by market', async () => {
    // Given
    const accountId = randomUUID();
    const { orderId } = (await placeOrder(accountId)).json();
    await core.acceptOrder.execute(orderId);

    // When
    const response = await app.inject({ method: 'POST', url: '/cancel_order', payload: { orderId, accountId } });

    // Then
    expect(response.json()).toEqual({ orderId, status: 'cancelling' });
    expect((await outboxOf(orderId)).map((row) => row.routing_key)).toEqual(['order.placed', 'order.accepted.BTC-USD', 'order.cancelRequested.BTC-USD']);
  });
});

describe('Persistence', () => {
  test('Should write order and order_view together, or neither when the transaction fails', async () => {
    // Given
    const repository = new KyselyOrderRepository(core.runner, fixedClock(new Date()));
    const order = Order.place({
      orderId: OrderId.from(randomUUID()),
      accountId: AccountId.from(randomUUID()),
      marketId: MarketId.from('BTC-USD'),
      side: Side.from('sell'),
      quantity: Quantity.from('1'),
      price: Price.from('100'),
      filters: new MarketFilters(Price.from('0.01'), Quantity.from('0.00001'), Quantity.from('0.00001'), Quantity.from('5')),
      now: new Date(),
    });
    const orderId = order.snapshot.orderId.value;

    // When
    await expect(
      core.runner.run(async () => {
        await repository.save(order);
        throw new Error('failure after saving');
      }),
    ).rejects.toThrowError('failure after saving');

    // Then
    expect(await database.db.selectFrom('order').select('order_id').where('order_id', '=', orderId).execute()).toEqual([]);
    expect(await database.db.selectFrom('order_view').select('order_id').where('order_id', '=', orderId).execute()).toEqual([]);
  });
});

describe('Saga S2 timeout job', () => {
  test('Should expire pending orders older than the timeout and publish order.voided', async () => {
    // Given
    const accountId = randomUUID();
    const { orderId } = (await placeOrder(accountId)).json();
    const later = buildOrderCore({ db: database.db, clock: fixedClock(new Date(Date.now() + 121_000)), pendingTimeoutMs: 120_000 });
    const job = new ExpirePendingOrders({ orderDao: later.orderDao, expireOrder: later.expireOrder, clock: later.clock, pendingTimeoutMs: 120_000, intervalMs: 1_000 });

    // When
    await job.runOnce();

    // Then
    expect((await core.getOrder.execute(orderId)).status).toBe('expired');
    expect((await core.getOrder.execute(orderId)).statusReason).toBe('EXPIRED');
    expect((await outboxOf(orderId)).at(-1)?.routing_key).toBe('order.voided');
  });
});

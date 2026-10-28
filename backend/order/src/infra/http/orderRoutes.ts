import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlaceOrderInput } from '../../application/dtos/placeOrderDto.js';
import type { CancelOrder } from '../../application/usecases/cancelOrder.js';
import type { GetOrder } from '../../application/usecases/getOrder.js';
import type { GetOrders } from '../../application/usecases/getOrders.js';
import type { PlaceOrder } from '../../application/usecases/placeOrder.js';
import {
  ConcurrentOrderUpdateError,
  InvalidOrderDataError,
  InvalidOrderTransitionError,
  NotOrderOwnerError,
  OrderNotFoundError,
} from '../../domain/errors.js';
import type { ErrorMapping } from '../platform/http/errors/errorMapping.js';
import type { RateLimitGroup } from '../platform/http/rateLimit/rateLimitPlugin.js';
import type { RateLimitPolicy } from '../platform/http/rateLimit/slidingWindow.js';
import { correlationFrom, withCorrelation } from '../platform/observability/correlation.js';

type Limit = Omit<RateLimitPolicy, 'name'>;

export interface OrderRateLimits {
  readonly ordersPerIp: Limit;
  readonly ordersPerAccount: Limit;
  readonly ordersPerAccountDaily: Limit;
  readonly privateReadPerIp: Limit;
  readonly privateReadPerAccount: Limit;
}

const second = 1_000;
const minute = 60 * second;

export const defaultOrderRateLimits: OrderRateLimits = {
  ordersPerIp: { limit: 100, windowMs: 10 * second },
  ordersPerAccount: { limit: 50, windowMs: 10 * second },
  ordersPerAccountDaily: { limit: 100_000, windowMs: 24 * 60 * minute },
  privateReadPerIp: { limit: 600, windowMs: minute },
  privateReadPerAccount: { limit: 300, windowMs: minute },
};

export const orderErrorMappings: readonly ErrorMapping[] = [
  { error: InvalidOrderDataError, statusCode: 422, code: 'invalidOrderData' },
  { error: OrderNotFoundError, statusCode: 404, code: 'orderNotFound' },
  { error: NotOrderOwnerError, statusCode: 403, code: 'notOrderOwner' },
  { error: InvalidOrderTransitionError, statusCode: 409, code: 'invalidOrderTransition' },
  { error: ConcurrentOrderUpdateError, statusCode: 409, code: 'concurrentUpdate' },
];

const bodyAccountOf = (request: FastifyRequest): string | undefined => {
  const accountId = (request.body as { accountId?: unknown } | undefined)?.accountId;
  return typeof accountId === 'string' ? accountId : undefined;
};

const paramAccountOf = (request: FastifyRequest): string | undefined => (request.params as { accountId?: string }).accountId;

const orderRoutes = new Set(['/place_order', '/cancel_order']);
const readRoutes = new Set(['/accounts/:accountId/orders', '/orders/:orderId']);

export const orderRateLimitGroups = (limits: OrderRateLimits): readonly RateLimitGroup[] => [
  {
    name: 'orders',
    matches: (request) => request.method === 'POST' && orderRoutes.has(request.routeOptions.url ?? ''),
    perIp: limits.ordersPerIp,
    perSubject: [
      { label: 'account', ...limits.ordersPerAccount, subjectOf: bodyAccountOf },
      { label: 'accountDaily', ...limits.ordersPerAccountDaily, subjectOf: bodyAccountOf },
    ],
  },
  {
    name: 'privateRead',
    matches: (request) => request.method === 'GET' && readRoutes.has(request.routeOptions.url ?? ''),
    perIp: limits.privateReadPerIp,
    perSubject: { label: 'account', ...limits.privateReadPerAccount, subjectOf: paramAccountOf },
    costOf: (request) => (request.routeOptions.url === '/accounts/:accountId/orders' ? 5 : 1),
  },
];

const decimal = { type: 'string', maxLength: 40 } as const;

const placeOrderBody = {
  type: 'object',
  required: ['marketId', 'accountId', 'side', 'quantity', 'price'],
  additionalProperties: false,
  properties: { marketId: { type: 'string', maxLength: 11 }, accountId: { type: 'string', maxLength: 36 }, side: { type: 'string', maxLength: 4 }, quantity: decimal, price: decimal },
} as const;

const cancelOrderBody = {
  type: 'object',
  required: ['orderId', 'accountId'],
  additionalProperties: false,
  properties: { orderId: { type: 'string', maxLength: 36 }, accountId: { type: 'string', maxLength: 36 } },
} as const;

export interface OrderRouteUseCases {
  readonly placeOrder: PlaceOrder;
  readonly cancelOrder: CancelOrder;
  readonly getOrders: GetOrders;
  readonly getOrder: GetOrder;
}

const correlationOf = (request: FastifyRequest) => correlationFrom(request.headers['x-correlation-id'] as string | undefined);

export const registerOrderRoutes = (app: FastifyInstance, useCases: OrderRouteUseCases): void => {
  app.post('/place_order', { schema: { body: placeOrderBody } }, async (request, reply) => {
    const correlation = correlationOf(request);
    const placeOrderInput = request.body as PlaceOrderInput;
    const orderId = await withCorrelation(correlation, () => useCases.placeOrder.execute(placeOrderInput));
    return reply.status(202).header('x-correlation-id', correlation.correlationId).send({ orderId, status: 'pending' });
  });

  app.post('/cancel_order', { schema: { body: cancelOrderBody } }, async (request, reply) => {
    const correlation = correlationOf(request);
    const { orderId, accountId } = request.body as { orderId: string; accountId: string };
    const status = await withCorrelation(correlation, () => useCases.cancelOrder.execute(orderId, accountId));
    return reply.status(202).header('x-correlation-id', correlation.correlationId).send({ orderId, status });
  });

  app.get('/accounts/:accountId/orders', async (request, reply) => {
    const status = (request.query as { status?: string }).status;
    return reply.send(await useCases.getOrders.execute(String(paramAccountOf(request)), status));
  });

  app.get('/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    return reply.send(await useCases.getOrder.execute(orderId));
  });
};

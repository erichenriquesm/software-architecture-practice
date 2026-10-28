import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FundsMovement } from '../../application/dtos/fundsMovement.js';
import type { Deposit } from '../../application/usecases/deposit.js';
import type { Withdraw } from '../../application/usecases/withdraw.js';
import {
  ConcurrentWalletUpdateError,
  InsufficientFundsError,
  InvalidWalletDataError,
  WalletNotFoundError,
} from '../../domain/errors.js';
import { AccountServiceUnavailableError } from '../grpc/account/grpcAccountGateway.js';
import type { ErrorMapping } from '../platform/http/errors/errorMapping.js';
import type { RateLimitGroup } from '../platform/http/rateLimit/rateLimitPlugin.js';
import type { RateLimitPolicy } from '../platform/http/rateLimit/slidingWindow.js';
import { correlationFrom, withCorrelation } from '../platform/observability/correlation.js';

export interface WalletRateLimits {
  readonly movementPerIp: Omit<RateLimitPolicy, 'name'>;
  readonly movementPerAccount: Omit<RateLimitPolicy, 'name'>;
}

const minute = 60 * 1_000;

export const defaultWalletRateLimits: WalletRateLimits = {
  movementPerIp: { limit: 30, windowMs: minute },
  movementPerAccount: { limit: 10, windowMs: minute },
};

export const walletErrorMappings: readonly ErrorMapping[] = [
  { error: InvalidWalletDataError, statusCode: 422, code: 'invalidWalletData' },
  { error: InsufficientFundsError, statusCode: 422, code: 'insufficientFunds' },
  { error: WalletNotFoundError, statusCode: 404, code: 'accountNotFound' },
  { error: ConcurrentWalletUpdateError, statusCode: 409, code: 'concurrentUpdate' },
  { error: AccountServiceUnavailableError, statusCode: 503, code: 'accountServiceUnavailable' },
];

const accountIdOf = (request: FastifyRequest): string | undefined => {
  const accountId = (request.body as { accountId?: unknown } | undefined)?.accountId;
  return typeof accountId === 'string' ? accountId : undefined;
};

const isMovement = (request: FastifyRequest): boolean =>
  request.method === 'POST' && (request.routeOptions.url === '/deposit' || request.routeOptions.url === '/withdraw');

export const walletRateLimitGroups = (limits: WalletRateLimits): readonly RateLimitGroup[] => [
  {
    name: 'movement',
    matches: isMovement,
    perIp: limits.movementPerIp,
    perSubject: { label: 'account', ...limits.movementPerAccount, subjectOf: accountIdOf },
  },
];

const movementBody = {
  type: 'object',
  required: ['accountId', 'assetId', 'quantity'],
  additionalProperties: false,
  properties: {
    accountId: { type: 'string', maxLength: 36 },
    assetId: { type: 'string', maxLength: 5 },
    quantity: { type: 'string', maxLength: 40 },
  },
} as const;

export interface WalletRouteUseCases {
  readonly deposit: Deposit;
  readonly withdraw: Withdraw;
}

const correlationOf = (request: FastifyRequest) => correlationFrom(request.headers['x-correlation-id'] as string | undefined);

export const registerWalletRoutes = (app: FastifyInstance, useCases: WalletRouteUseCases): void => {
  app.post('/deposit', { schema: { body: movementBody } }, async (request, reply) => {
    const correlation = correlationOf(request);
    const movement = request.body as FundsMovement;
    await withCorrelation(correlation, () => useCases.deposit.execute(movement));
    return reply.status(204).header('x-correlation-id', correlation.correlationId).send();
  });

  app.post('/withdraw', { schema: { body: movementBody } }, async (request, reply) => {
    const correlation = correlationOf(request);
    const movement = request.body as FundsMovement;
    await withCorrelation(correlation, () => useCases.withdraw.execute(movement));
    return reply.status(204).header('x-correlation-id', correlation.correlationId).send();
  });
};

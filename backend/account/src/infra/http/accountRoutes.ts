import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GetAccount } from '../../application/usecases/getAccount.js';
import type { Signup } from '../../application/usecases/signup.js';
import type { SignupInput } from '../../application/dtos/signupDto.js';
import { AccountNotFoundError, DuplicateEmailError, InvalidAccountDataError } from '../../domain/errors.js';
import type { ErrorMapping } from '../platform/http/errors/errorMapping.js';
import type { RateLimitGroup } from '../platform/http/rateLimit/rateLimitPlugin.js';
import type { RateLimitPolicy } from '../platform/http/rateLimit/slidingWindow.js';
import { correlationFrom, withCorrelation } from '../platform/observability/correlation.js';

export interface AccountRateLimits {
  readonly authPerIp: Omit<RateLimitPolicy, 'name'>;
  readonly authPerEmail: Omit<RateLimitPolicy, 'name'>;
  readonly privateReadPerIp: Omit<RateLimitPolicy, 'name'>;
  readonly privateReadPerAccount: Omit<RateLimitPolicy, 'name'>;
}

const hour = 60 * 60 * 1_000;
const minute = 60 * 1_000;

export const defaultAccountRateLimits: AccountRateLimits = {
  authPerIp: { limit: 5, windowMs: hour },
  authPerEmail: { limit: 3, windowMs: hour },
  privateReadPerIp: { limit: 600, windowMs: minute },
  privateReadPerAccount: { limit: 300, windowMs: minute },
};

export const accountErrorMappings: readonly ErrorMapping[] = [
  { error: InvalidAccountDataError, statusCode: 422, code: 'invalidAccountData' },
  { error: DuplicateEmailError, statusCode: 409, code: 'emailAlreadyRegistered' },
  { error: AccountNotFoundError, statusCode: 404, code: 'accountNotFound' },
];

const emailOf = (request: FastifyRequest): string | undefined => {
  const email = (request.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
};

const accountIdOf = (request: FastifyRequest): string | undefined => (request.params as { accountId?: string }).accountId;

export const accountRateLimitGroups = (limits: AccountRateLimits): readonly RateLimitGroup[] => [
  {
    name: 'auth',
    matches: (request) => request.method === 'POST' && request.routeOptions.url === '/signup',
    perIp: limits.authPerIp,
    perSubject: { label: 'email', ...limits.authPerEmail, subjectOf: emailOf },
  },
  {
    name: 'privateRead',
    matches: (request) => request.method === 'GET' && request.routeOptions.url === '/accounts/:accountId',
    perIp: limits.privateReadPerIp,
    perSubject: { label: 'account', ...limits.privateReadPerAccount, subjectOf: accountIdOf },
  },
];

const signupBody = {
  type: 'object',
  required: ['name', 'email', 'document', 'password'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    email: { type: 'string', maxLength: 254 },
    document: { type: 'string', maxLength: 20 },
    password: { type: 'string', maxLength: 128 },
  },
} as const;

export interface AccountRouteUseCases {
  readonly signup: Signup;
  readonly getAccount: GetAccount;
}

const correlationOf = (request: FastifyRequest) => correlationFrom(request.headers['x-correlation-id'] as string | undefined);

export const registerAccountRoutes = (app: FastifyInstance, useCases: AccountRouteUseCases): void => {
  app.post('/signup', { schema: { body: signupBody } }, async (request, reply) => {
    const correlation = correlationOf(request);
    const signupInput = request.body as SignupInput;
    const accountId = await withCorrelation(correlation, () => useCases.signup.execute(signupInput));
    return reply.status(201).header('x-correlation-id', correlation.correlationId).send({ accountId });
  });

  app.get('/accounts/:accountId', async (request, reply) => {
    const correlation = correlationOf(request);
    const accountId = String(accountIdOf(request));
    const getAccountOutput = await withCorrelation(correlation, () => useCases.getAccount.execute(accountId));
    return reply.header('x-correlation-id', correlation.correlationId).send(getAccountOutput);
  });
};

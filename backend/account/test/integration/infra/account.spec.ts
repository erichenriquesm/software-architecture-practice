import grpc from '@grpc/grpc-js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../support/database.js';
import { createTestDatabase } from '../../support/database.js';
import type { FakeWallet } from '../../support/fakeWallet.js';
import { startFakeWallet } from '../../support/fakeWallet.js';
import type { PasswordHasher } from '../../../src/application/contracts/passwordHasher.js';
import type { Password } from '../../../src/domain/valueObjects/password.js';
import { PasswordHash } from '../../../src/domain/valueObjects/passwordHash.js';
import { startAccountGrpcServer } from '../../../src/infra/grpc/accountGrpcServer.js';
import { walletBalancesHandler } from '../../../src/infra/messaging/walletBalancesConsumer.js';
import { GrpcWalletGateway } from '../../../src/infra/grpc/wallet/grpcWalletGateway.js';
import { AccountServiceClient } from '../../../src/infra/generated/account.js';
import { buildAccountApi, buildAccountCore } from '../../../src/infra/composition.js';
import type { RateLimiter } from '../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { InMemoryRateLimiter } from '../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { createEnvelope, loadEnvelopeValidator } from '../../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../../src/infra/platform/messaging/schemas.js';
import { identify, parseAllowedCallers } from '../../../src/infra/platform/security/serviceAuth.js';

const fastHasher: PasswordHasher = { hash: async (password: Password) => PasswordHash.from(`$argon2id$test$${password.value.length}`) };
const fastRetry = { baseMs: 1, capMs: 5, maxAttempts: 3 };
const unlimited: RateLimiter = {
  check: async (check) => ({ allowed: true, remaining: check.policy.limit, resetSeconds: 0, retryAfterSeconds: 0, policy: check.policy }),
};
const accountIdentity = { name: 'account', token: 'account-grpc-test' };

let database: TestDatabase;
let wallet: FakeWallet;
let gateway: GrpcWalletGateway;
let app: FastifyInstance;

const signupBody = (email: string) => ({ name: 'Ana Souza', email, document: '529.982.247-25', password: 'Abcdefg1' });
const signup = (email: string) => app.inject({ method: 'POST', url: '/signup', payload: signupBody(email) });

beforeAll(async () => {
  database = await createTestDatabase();
  wallet = await startFakeWallet(parseAllowedCallers('account:account-grpc-test'));
  gateway = new GrpcWalletGateway({ address: wallet.address, identity: accountIdentity, retryPolicy: fastRetry });
  app = buildAccountApi({ db: database.db, rateLimiter: unlimited, wallet: gateway, passwordHasher: fastHasher });
});

afterEach(() => {
  wallet.calls = 0;
  wallet.answers = [];
});

afterAll(async () => {
  gateway.close();
  wallet.stop();
  await app.close();
  await database.destroy();
});

describe('Signup', () => {
  test('Should create the account and write a valid account.created envelope to the outbox in the same transaction', async () => {
    // When
    const response = await signup('first@example.com');

    // Then
    expect(response.statusCode).toBe(201);
    const { accountId } = response.json();
    const outbox = await database.db.selectFrom('outbox').select(['routing_key', 'envelope']).execute();
    const row = outbox.find((candidate) => (candidate.envelope as { payload: { accountId: string } }).payload.accountId === accountId);
    expect(row?.routing_key).toBe('account.created');
    const envelope = loadEnvelopeValidator()(row?.envelope);
    expect(loadSchemaValidator('src/infra/contracts/published/events/account.created.v1.schema.json')(envelope.payload)).toEqual({ accountId });
    expect(envelope.correlationId).toBe(response.headers['x-correlation-id']);
  });

  test('Should let only one of two concurrent signups with the same email succeed', async () => {
    // When
    const responses = await Promise.all([signup('race@example.com'), signup('RACE@example.com')]);

    // Then
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('Signup rate limit', () => {
  test('Should allow 3 attempts per email and 5 per IP per hour, then answer 429 with Retry-After', async () => {
    // Given
    const limitedApp = buildAccountApi({ db: database.db, rateLimiter: new InMemoryRateLimiter('account'), wallet: gateway, passwordHasher: fastHasher });
    const attempt = (email: string) => limitedApp.inject({ method: 'POST', url: '/signup', payload: signupBody(email) });

    // When
    const sameEmail = [await attempt('limit@example.com'), await attempt('limit@example.com'), await attempt('limit@example.com'), await attempt('limit@example.com')];
    const otherEmails = [await attempt('limit2@example.com'), await attempt('limit3@example.com')];

    // Then
    expect(sameEmail.map((response) => response.statusCode)).toEqual([201, 409, 409, 429]);
    expect(Number(sameEmail[3]?.headers['retry-after'])).toBeGreaterThan(0);
    expect(otherEmails.map((response) => response.statusCode)).toEqual([201, 429]);
    await limitedApp.close();
  });
});

describe('GetAccount balances', () => {
  const projectBalance = async (accountId: string, available: string, version: number) =>
    buildAccountCore(database.db).projectWalletBalance.execute({ accountId, assetId: 'USD', available, reserved: '0', version });

  test('Should answer from the projection (ok) and keep the newest version when an older one arrives late', async () => {
    // Given
    const { accountId } = (await signup('projected@example.com')).json();
    await projectBalance(accountId, '200', 2);
    await projectBalance(accountId, '100', 1);

    // When
    const response = await app.inject({ method: 'GET', url: `/accounts/${accountId}` });

    // Then
    expect(response.json()).toMatchObject({
      balancesStatus: 'ok',
      assets: [{ assetId: 'USD', quantity: '200.00000000', available: '200.00000000', reserved: '0.00000000' }],
    });
    expect(wallet.calls).toBe(0);
  });

  test('Should ask the wallet (live), retrying a transient UNAVAILABLE, when the projection is empty', async () => {
    // Given
    const { accountId } = (await signup('live@example.com')).json();
    wallet.answers = [grpc.status.UNAVAILABLE, { balances: [{ assetId: 'BTC', available: '0.5', reserved: '0.1' }], version: 3 }];

    // When
    const response = await app.inject({ method: 'GET', url: `/accounts/${accountId}` });

    // Then
    expect(response.json()).toMatchObject({ balancesStatus: 'live', assets: [{ assetId: 'BTC', quantity: '0.60000000' }] });
    expect(wallet.calls).toBe(2);
  });

  test('Should treat NOT_FOUND from the wallet as a wallet without balances', async () => {
    // Given
    const { accountId } = (await signup('nowallet@example.com')).json();
    wallet.answers = [grpc.status.NOT_FOUND];

    // When
    const response = await app.inject({ method: 'GET', url: `/accounts/${accountId}` });

    // Then
    expect(response.json()).toMatchObject({ balancesStatus: 'live', assets: [] });
  });

  test('Should degrade without retrying when the wallet denies the call', async () => {
    // Given
    const { accountId } = (await signup('denied@example.com')).json();
    wallet.answers = [grpc.status.PERMISSION_DENIED];

    // When
    const response = await app.inject({ method: 'GET', url: `/accounts/${accountId}` });

    // Then
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balancesStatus: 'unavailable', assets: [] });
    expect(wallet.calls).toBe(1);
  });
});

describe('wallet.balanceChanged consumer handler', () => {
  test('Should project a valid event and reject a payload outside the contract', async () => {
    // Given
    const { accountId } = (await signup('consumer@example.com')).json();
    const core = buildAccountCore(database.db);
    const handler = walletBalancesHandler(core.projectWalletBalance);
    const envelopeWith = (payload: Record<string, unknown>) =>
      createEnvelope({ type: 'wallet.balanceChanged', version: 1, producer: 'wallet', correlationId: '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69', payload });

    // When
    await core.runner.run(() => handler(envelopeWith({ accountId, assetId: 'USD', available: '7.5', reserved: '2.5', version: 1 }), core.runner.transaction()));

    // Then
    const balances = await core.balanceDao.listByAccount(accountId);
    expect(balances).toEqual([{ assetId: 'USD', available: '7.50000000', reserved: '2.50000000' }]);
    await expect(core.runner.run(() => handler(envelopeWith({ accountId, assetId: 'USD' }), core.runner.transaction()))).rejects.toThrowError(
      /wallet\.balanceChanged/,
    );
  });
});

describe('AccountService.Exists with name + token', () => {
  test('Should answer the wallet, refuse a wrong token and deny a caller outside the allowlist', async () => {
    // Given
    const { accountId } = (await signup('grpc@example.com')).json();
    const { server, port } = await startAccountGrpcServer({
      accountExists: buildAccountCore(database.db).accountExists,
      allowedCallers: parseAllowedCallers('wallet:wallet-grpc-test,order:order-grpc-test'),
      address: '127.0.0.1:0',
    });
    const client = new AccountServiceClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const existsAs = (name: string, token: string, id: string) =>
      new Promise<boolean>((resolve, reject) =>
        client.exists({ accountId: id }, identify(new grpc.Metadata(), { name, token }), (error, response) =>
          error ? reject(error) : resolve(response.exists),
        ),
      );

    // When & Then
    await expect(existsAs('wallet', 'wallet-grpc-test', accountId)).resolves.toBe(true);
    await expect(existsAs('wallet', 'wallet-grpc-test', '0199d5f4-2b9a-7c3e-9a51-2f1d3c4b5a69')).resolves.toBe(false);
    await expect(existsAs('wallet', 'wrong-token', accountId)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    await expect(existsAs('order', 'order-grpc-test', accountId)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    client.close();
    server.forceShutdown();
  });
});

describe('WalletService gateway identity', () => {
  test('Should degrade without retrying when the wallet does not recognize the caller token', async () => {
    // Given
    const { accountId } = (await signup('untrusted@example.com')).json();
    const untrusted = new GrpcWalletGateway({ address: wallet.address, identity: { name: 'account', token: 'stale' }, retryPolicy: fastRetry });
    const untrustedApp = buildAccountApi({ db: database.db, rateLimiter: unlimited, wallet: untrusted, passwordHasher: fastHasher });
    wallet.answers = [{ balances: [], version: 0 }];

    // When
    const response = await untrustedApp.inject({ method: 'GET', url: `/accounts/${accountId}` });

    // Then
    expect(response.json()).toMatchObject({ balancesStatus: 'unavailable', assets: [] });
    expect(wallet.calls).toBe(0);
    untrusted.close();
    await untrustedApp.close();
  });
});

import { randomUUID } from 'node:crypto';
import grpc from '@grpc/grpc-js';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { FakeAccount } from '../../support/fakeAccount.js';
import { startFakeAccount } from '../../support/fakeAccount.js';
import type { TestDatabase } from '../../support/database.js';
import { createTestDatabase } from '../../support/database.js';
import type { WalletCore } from '../../../src/infra/composition.js';
import { buildWalletApi } from '../../../src/infra/composition.js';
import { GrpcAccountGateway } from '../../../src/infra/grpc/account/grpcAccountGateway.js';
import { startWalletGrpcServer } from '../../../src/infra/grpc/walletGrpcServer.js';
import { WalletServiceClient } from '../../../src/infra/generated/wallet.js';
import type { RateLimiter } from '../../../src/infra/platform/http/rateLimit/rateLimiter.js';
import { loadEnvelopeValidator } from '../../../src/infra/platform/messaging/envelope.js';
import { loadSchemaValidator } from '../../../src/infra/platform/messaging/schemas.js';
import { identify, parseAllowedCallers } from '../../../src/infra/platform/security/serviceAuth.js';

const unlimited: RateLimiter = {
  check: async (check) => ({ allowed: true, remaining: check.policy.limit, resetSeconds: 0, retryAfterSeconds: 0, policy: check.policy }),
};

let database: TestDatabase;
let account: FakeAccount;
let gateway: GrpcAccountGateway;
let app: FastifyInstance;
let core: WalletCore;

const newAccount = (): string => {
  const accountId = randomUUID();
  account.existing.add(accountId);
  return accountId;
};

const post = (url: '/deposit' | '/withdraw', accountId: string, assetId: string, quantity: string) =>
  app.inject({ method: 'POST', url, payload: { accountId, assetId, quantity } });

const balanceOf = async (accountId: string, assetId: string) =>
  database.db.selectFrom('balance').select(['available', 'reserved']).where('account_id', '=', accountId).where('asset_id', '=', assetId).executeTakeFirst();

beforeAll(async () => {
  database = await createTestDatabase();
  account = await startFakeAccount(parseAllowedCallers('wallet:wallet-grpc-test'));
  gateway = new GrpcAccountGateway({
    address: account.address,
    identity: { name: 'wallet', token: 'wallet-grpc-test' },
    retryPolicy: { baseMs: 1, capMs: 5, maxAttempts: 3 },
  });
  ({ app, core } = buildWalletApi({ db: database.db, accountGateway: gateway, rateLimiter: unlimited }));
});

afterEach(() => {
  account.unavailable = false;
  account.calls = 0;
});

afterAll(async () => {
  gateway.close();
  account.stop();
  await app.close();
  await database.destroy();
});

describe('POST /deposit and /withdraw', () => {
  test('Should open the wallet of an existing account, write the ledger and a valid wallet.balanceChanged to the outbox', async () => {
    // Given
    const accountId = newAccount();

    // When
    const response = await post('/deposit', accountId, 'USD', '150.50');

    // Then
    expect(response.statusCode).toBe(204);
    expect(await balanceOf(accountId, 'USD')).toEqual({ available: '150.50000000', reserved: '0.00000000' });
    const ledger = await database.db.selectFrom('ledger_entry').select(['reason', 'available_delta']).where('account_id', '=', accountId).execute();
    expect(ledger).toEqual([{ reason: 'DEPOSIT', available_delta: '150.50000000' }]);
    const outbox = await database.db.selectFrom('outbox').select(['routing_key', 'envelope']).where(sql<string>`envelope->'payload'->>'accountId'`, '=', accountId).execute();
    expect(outbox.map((row) => row.routing_key)).toEqual(['wallet.balanceChanged']);
    const envelope = loadEnvelopeValidator()(outbox[0]?.envelope);
    expect(loadSchemaValidator('src/infra/contracts/published/events/wallet.balanceChanged.v1.schema.json')(envelope.payload)).toMatchObject({
      accountId,
      assetId: 'USD',
      available: '150.50000000',
      version: 1,
    });
  });

  test('Should answer 404 for an unknown account, 503 when the account service is down and 422 for invalid amounts', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '10');

    // When
    const unknown = await post('/deposit', randomUUID(), 'USD', '10');
    account.unavailable = true;
    const accountDown = await post('/deposit', randomUUID(), 'USD', '10');
    account.unavailable = false;
    const tooPrecise = await post('/deposit', accountId, 'USD', '1.001');
    const tooMuch = await post('/withdraw', accountId, 'USD', '10.01');

    // Then
    expect([unknown.statusCode, accountDown.statusCode, tooPrecise.statusCode, tooMuch.statusCode]).toEqual([404, 503, 422, 422]);
    expect(tooMuch.json()).toMatchObject({ error: 'insufficientFunds' });
  });

  test('Should keep every concurrent deposit through optimistic locking (reload and retry)', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1');

    // When
    const responses = await Promise.all([post('/deposit', accountId, 'USD', '10'), post('/deposit', accountId, 'USD', '10'), post('/deposit', accountId, 'USD', '10')]);

    // Then
    expect(responses.map((response) => response.statusCode)).toEqual([204, 204, 204]);
    expect(await balanceOf(accountId, 'USD')).toMatchObject({ available: '31.00000000' });
  });

  test('Should keep the database check as the last defense against a negative balance', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1');

    // When & Then
    await expect(sql`update balance set available = -1 where account_id = ${accountId}`.execute(database.db)).rejects.toThrowError(/balance_available_not_negative/);
  });
});

describe('Reservation and its compensation (saga S2) on Postgres', () => {
  test('Should never leave funds reserved when order.placed and order.voided race each other', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'USD', '1000');
    const orders = Array.from({ length: 5 }, () => randomUUID());

    // When
    await Promise.all(
      orders.flatMap((orderId) => [
        core.reserveFunds.execute({ orderId, accountId, marketId: 'BTC-USD', side: 'buy', quantity: '1', price: '100' }),
        core.compensateReservation.execute(orderId, accountId),
      ]),
    );

    // Then
    expect(await balanceOf(accountId, 'USD')).toEqual({ available: '1000.00000000', reserved: '0.00000000' });
    const voided = await database.db.selectFrom('voided_order').select('order_id').where('order_id', 'in', orders).execute();
    expect(voided).toHaveLength(5);
  });
});

describe('WalletService.GetBalances with name + token', () => {
  test('Should answer the account service, refuse a wrong token and answer NOT_FOUND for an unknown wallet', async () => {
    // Given
    const accountId = newAccount();
    await post('/deposit', accountId, 'BTC', '0.5');
    const { server, port } = await startWalletGrpcServer({
      getBalances: core.getBalances,
      allowedCallers: parseAllowedCallers('account:account-grpc-test'),
      address: '127.0.0.1:0',
    });
    const client = new WalletServiceClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const getBalancesAs = (token: string, id: string) =>
      new Promise((resolve, reject) =>
        client.getBalances({ accountId: id }, identify(new grpc.Metadata(), { name: 'account', token }), (error, response) =>
          error ? reject(error) : resolve(response),
        ),
      );

    // When & Then
    await expect(getBalancesAs('account-grpc-test', accountId)).resolves.toMatchObject({
      balances: [{ assetId: 'BTC', available: '0.50000000', reserved: '0.00000000' }],
    });
    await expect(getBalancesAs('wrong', accountId)).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    await expect(getBalancesAs('account-grpc-test', randomUUID())).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
    client.close();
    server.forceShutdown();
  });
});

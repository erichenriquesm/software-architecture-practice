import { readFileSync } from 'node:fs';
import grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestCa } from '../../../../test/support/certificates.js';
import { callPing, createProbeClient, probeMethod, probeServiceDefinition } from '../../../../test/support/probeService.js';
import type { DeniedCall } from './allowlist.js';
import { allowlistInterceptor } from './allowlist.js';
import { clientCredentials, serverCredentials } from './grpcCredentials.js';

const ca = createTestCa();
const foreignCa = createTestCa('foreign-ca');
const deniedCalls: DeniedCall[] = [];
let handlerCalls = 0;
let address = '';
let server: grpc.Server;

beforeAll(async () => {
  server = new grpc.Server({
    interceptors: [allowlistInterceptor({ [probeMethod]: ['wallet'] }, (deniedCall) => deniedCalls.push(deniedCall))],
  });
  server.addService(probeServiceDefinition, {
    ping: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
      handlerCalls += 1;
      callback(null, { pong: true });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', serverCredentials(ca.issue('DNS:account-api')), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  address = `127.0.0.1:${port}`;
});

afterAll(() => server.forceShutdown());

const clientWith = (credentials: grpc.ChannelCredentials) => createProbeClient(address, credentials, 'account-api');

describe('gRPC mTLS with allowlist', () => {
  test('Should serve a caller that is in the allowlist', async () => {
    // Given
    const client = clientWith(clientCredentials(ca.issue('DNS:wallet-api')));

    // When
    const response = await callPing(client);

    // Then
    expect(response).toEqual({ pong: true });
    client.close();
  });

  test('Should deny a caller outside the allowlist with PERMISSION_DENIED, without running the handler', async () => {
    // Given
    const client = clientWith(clientCredentials(ca.issue('DNS:order-api')));
    const metadata = new grpc.Metadata();
    metadata.set('x-correlation-id', 'corr-1');
    const callsBefore = handlerCalls;

    // When & Then
    await expect(callPing(client, metadata)).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    expect(handlerCalls).toBe(callsBefore);
    expect(deniedCalls).toContainEqual({ caller: 'order', method: probeMethod, correlationId: 'corr-1' });
    client.close();
  });

  test('Should refuse a client without a certificate', async () => {
    // Given
    const client = clientWith(grpc.credentials.createSsl(readFileSync(ca.caFile)));

    // When & Then
    await expect(callPing(client)).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });

  test('Should refuse a client certificate signed by another CA', async () => {
    // Given
    const foreign = foreignCa.issue('DNS:wallet-api');
    const client = clientWith(
      grpc.credentials.createSsl(readFileSync(ca.caFile), readFileSync(foreign.keyFile), readFileSync(foreign.certFile)),
    );

    // When & Then
    await expect(callPing(client)).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });
});

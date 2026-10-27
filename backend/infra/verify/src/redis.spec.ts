import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { Redis } from 'ioredis';
import { readSecret } from './secrets.ts';

const host = process.env.REDIS_HOST ?? 'redis';

const clientFor = (options: { username: string; password: string }): Redis =>
  new Redis({
    host,
    port: 6379,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    ...options,
  }).on('error', () => undefined);

const sendRaw = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 6379 }, () => socket.write(command));
    socket.once('data', (data) => {
      socket.destroy();
      resolve(data.toString());
    });
    socket.once('error', reject);
  });

describe('Redis ACL', () => {
  let wallet: Redis;

  before(async () => {
    wallet = clientFor({ username: 'wallet', password: readSecret('wallet-redis-password') });
    await wallet.connect();
  });

  after(() => wallet.disconnect());

  test('Should refuse a command without a user', async () => {
    const reply = await sendRaw('PING\r\n');

    assert.match(reply, /^-NOAUTH/);
  });

  test('Should let wallet write under its own prefix', async () => {
    assert.equal(await wallet.set('wallet:verify', '1', 'PX', 1000), 'OK');
  });

  test('Should deny wallet reading another service prefix', async () => {
    await assert.rejects(wallet.get('account:verify'), /NOPERM/);
  });

  test('Should deny dangerous commands', async () => {
    await assert.rejects(wallet.keys('*'), /NOPERM/);
    await assert.rejects(wallet.flushall(), /NOPERM/);
  });
});

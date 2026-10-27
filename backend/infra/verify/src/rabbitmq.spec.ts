import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import amqp from 'amqplib';
import { readSecret } from './secrets.ts';

const host = process.env.RABBITMQ_HOST ?? 'rabbitmq';
const vhost = 'trading';

const urlFor = (user: string, password: string): string =>
  `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5672/${vhost}`;

const connectAs = (user: string) => amqp.connect(urlFor(user, readSecret(`${user}-rabbitmq-password`)));

describe('RabbitMQ authentication and permissions', () => {
  test('Should refuse the default guest user', async () => {
    await assert.rejects(amqp.connect(urlFor('guest', 'guest')));
  });

  test('Should refuse a wrong password', async () => {
    await assert.rejects(amqp.connect(urlFor('wallet', 'wrong-password')));
  });

  test('Should let wallet see its own exchange', async () => {
    const connection = await connectAs('wallet');
    const channel = await connection.createChannel();

    await channel.checkExchange('wallet.events');

    await connection.close();
  });

  test('Should refuse wallet publishing to the account exchange', async () => {
    const connection = await connectAs('wallet');
    const channel = await connection.createConfirmChannel();
    const closed = new Promise<Error>((resolve) => channel.on('error', resolve));

    channel.publish('account.events', 'account.created', Buffer.from('{}'));
    const error = await closed;

    assert.match(error.message, /ACCESS_REFUSED/);
    await connection.close();
  });
});

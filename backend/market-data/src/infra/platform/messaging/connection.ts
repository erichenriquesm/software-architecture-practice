import amqp from 'amqplib';
import { numberEnv, requiredEnv } from '../config/env.js';

export type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

export const rabbitMqUrlFromEnv = (env: NodeJS.ProcessEnv = process.env): string => {
  const user = encodeURIComponent(requiredEnv('RABBITMQ_USER', env));
  const password = encodeURIComponent(requiredEnv('RABBITMQ_PASSWORD', env));
  const host = requiredEnv('RABBITMQ_HOST', env);
  const vhost = encodeURIComponent(env.RABBITMQ_VHOST ?? 'trading');
  const port = numberEnv('RABBITMQ_PORT', 5672, env);
  return `amqp://${user}:${password}@${host}:${port}/${vhost}`;
};

export const connectRabbitMq = (url: string): Promise<AmqpConnection> => amqp.connect(url);

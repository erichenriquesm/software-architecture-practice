import amqp from 'amqplib';
import { readSecretFile, requiredEnv } from '../security/secrets.js';

export type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

export const rabbitMqUrlFromEnv = (env: NodeJS.ProcessEnv = process.env): string => {
  const user = encodeURIComponent(requiredEnv('RABBITMQ_USER', env));
  const password = encodeURIComponent(readSecretFile('RABBITMQ_PASSWORD_FILE', env));
  const host = requiredEnv('RABBITMQ_HOST', env);
  const vhost = encodeURIComponent(env.RABBITMQ_VHOST ?? 'trading');
  return `amqp://${user}:${password}@${host}:5672/${vhost}`;
};

export const connectRabbitMq = (url: string): Promise<AmqpConnection> => amqp.connect(url);

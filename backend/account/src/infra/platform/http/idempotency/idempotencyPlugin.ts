import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdempotencyStore } from './idempotencyStore.js';

const header = 'idempotency-key';
const minimumTtlMs = 24 * 60 * 60 * 1_000;

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { readonly scope: string; readonly key: string } | undefined;
  }
}

const scopeOf = (request: FastifyRequest): string => `${request.method} ${request.routeOptions.url ?? request.url}`;

const hashOf = (body: unknown): string => createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

const keyOf = (request: FastifyRequest): string | undefined => {
  const value = request.headers[header];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const registerIdempotency = (app: FastifyInstance, store: IdempotencyStore, ttlMs = minimumTtlMs): void => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = keyOf(request);
    if (request.method !== 'POST' || key === undefined) return;

    const scope = scopeOf(request);
    const result = await store.begin(scope, key, hashOf(request.body), Math.max(ttlMs, minimumTtlMs));
    if (result.kind === 'started') {
      request.idempotency = { scope, key };
      return;
    }
    if (result.kind === 'replay') return reply.status(result.statusCode).header('Idempotent-Replayed', 'true').send(result.body);
    if (result.kind === 'mismatch') return reply.status(422).send({ error: 'idempotencyKeyReused' });
    return reply.status(409).send({ error: 'idempotentRequestInProgress' });
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const pending = request.idempotency;
    if (!pending) return payload;
    request.idempotency = undefined;

    if (reply.statusCode >= 500) {
      await store.release(pending.scope, pending.key);
      return payload;
    }
    const body = typeof payload === 'string' && payload.length > 0 ? JSON.parse(payload) : null;
    await store.complete(pending.scope, pending.key, reply.statusCode, body);
    return payload;
  });
};

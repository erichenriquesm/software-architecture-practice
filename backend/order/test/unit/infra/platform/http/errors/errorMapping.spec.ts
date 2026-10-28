import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { registerErrorMapping } from '../../../../../../src/infra/platform/http/errors/errorMapping.js';

class InsufficientFundsError extends Error {}

describe('Error mapping', () => {
  const buildApp = () => {
    const app = Fastify({ logger: false });
    registerErrorMapping(app, [{ error: InsufficientFundsError, statusCode: 422, code: 'insufficientFunds' }]);
    app.get('/mapped', async () => Promise.reject(new InsufficientFundsError('not enough USD')));
    app.get('/unmapped', async () => Promise.reject(new Error('boom')));
    return app;
  };

  test('Should translate a mapped domain error into its status and code', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/mapped' });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'insufficientFunds', message: 'not enough USD' });
  });

  test('Should hide an unmapped error behind a generic 500', async () => {
    const response = await buildApp().inject({ method: 'GET', url: '/unmapped' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internalError' });
  });
});

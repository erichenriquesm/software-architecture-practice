import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const edgeUrl = process.env.EDGE_URL ?? 'http://edge';

describe('Edge proxy', () => {
  test('Should answer the health check when no service is running', async () => {
    const response = await fetch(`${edgeUrl}/healthz`);

    assert.equal(response.status, 200);
  });

  test('Should answer 502 in JSON when the route service is down', async () => {
    const response = await fetch(`${edgeUrl}/orders/any-id`);

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'upstreamUnavailable' });
  });

  test('Should answer 404 for an unknown route', async () => {
    const response = await fetch(`${edgeUrl}/unknown`);

    assert.equal(response.status, 404);
  });

  test('Should reject a body larger than 16k with 413', async () => {
    const response = await fetch(`${edgeUrl}/deposit`, { method: 'POST', body: 'a'.repeat(20_000) });

    assert.equal(response.status, 413);
  });

  test('Should answer 429 with Retry-After when the auth zone burst is exceeded', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${edgeUrl}/signup`, { method: 'POST' })),
    );
    const limited = responses.find((response) => response.status === 429);

    assert.ok(limited, 'expected at least one 429');
    assert.equal(limited.headers.get('retry-after'), '1');
  });
});

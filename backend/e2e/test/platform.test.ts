import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

// Repeatable on a platform that already has data: two fixed accounts (signup only on the first run, since signup
// is limited to 5 per IP per hour), balances compared as deltas, and prices inside the current spread so these
// orders only ever match each other.

const edge = process.env.EDGE_URL ?? 'http://127.0.0.1:8080';
const market = 'BTC-USD';
const password = 'E2eSecret1';
const scale = 100_000_000n;

interface Account {
  readonly accountId: string;
  readonly cookie: string;
}

interface Balance {
  readonly available: bigint;
  readonly reserved: bigint;
}

interface Order {
  readonly orderId: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly fillQuantity: string;
}

const units = (decimal: string): bigint => {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(whole.replace('-', '')) * scale + BigInt(fraction.padEnd(8, '0').slice(0, 8)));
};

const call = async (method: string, path: string, options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && ['/deposit', '/withdraw', '/place_order', '/cancel_order'].includes(path)) headers['idempotency-key'] = randomUUID();
  const response = await fetch(`${edge}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : undefined };
};

const eventually = async <T>(probe: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const login = async (email: string) => {
  const response = await call('POST', '/login', { body: { email, password } });
  if (response.status !== 204) return undefined;
  return String(response.headers.get('set-cookie')).split(';')[0];
};

const accountFor = async (role: string): Promise<Account> => {
  const email = `e2e-${role}@example.com`;
  let cookie = await login(email);
  if (!cookie) {
    const signup = await call('POST', '/signup', { body: { name: `E2e ${role[0]?.toUpperCase()}${role.slice(1)}`, email, document: '529.982.247-25', password } });
    assert.equal(signup.status, 201, `signup of ${email}: ${JSON.stringify(signup.json)}`);
    cookie = await login(email);
  }
  assert.ok(cookie, `login of ${email}`);
  const me = await call('GET', '/me', { cookie });
  assert.equal(me.status, 200);
  return { accountId: me.json.accountId, cookie };
};

const balanceOf = async (account: Account, assetId: string): Promise<Balance> => {
  const response = await call('GET', `/accounts/${account.accountId}`, { cookie: account.cookie });
  assert.equal(response.status, 200);
  const asset = (response.json.assets as Array<{ assetId: string; available: string; reserved: string }>).find((candidate) => candidate.assetId === assetId);
  return { available: units(asset?.available ?? '0'), reserved: units(asset?.reserved ?? '0') };
};

const balanceBecomes = (account: Account, assetId: string, expected: (balance: Balance) => boolean, what: string) =>
  eventually(async () => {
    const balance = await balanceOf(account, assetId);
    return expected(balance) ? balance : undefined;
  }, what);

const deposit = async (account: Account, assetId: string, quantity: string) => {
  const response = await call('POST', '/deposit', { cookie: account.cookie, body: { assetId, quantity } });
  assert.equal(response.status, 204, JSON.stringify(response.json));
};

/** Deposits and waits until GetAccount shows exactly that much more, so later deltas start from a settled balance. */
const depositAndSettle = async (account: Account, assetId: string, quantity: string): Promise<Balance> => {
  const before = await balanceOf(account, assetId);
  await deposit(account, assetId, quantity);
  return balanceBecomes(account, assetId, (balance) => balance.available === before.available + units(quantity), `the ${assetId} deposit`);
};

const placeOrder = async (account: Account, side: 'buy' | 'sell', quantity: string, price: string): Promise<string> => {
  const response = await call('POST', '/place_order', { cookie: account.cookie, body: { marketId: market, side, quantity, price } });
  assert.equal(response.status, 202, JSON.stringify(response.json));
  return response.json.orderId;
};

const orderReaches = (account: Account, orderId: string, statuses: readonly string[]): Promise<Order> =>
  eventually(async () => {
    const response = await call('GET', `/orders/${orderId}`, { cookie: account.cookie });
    return response.status === 200 && statuses.includes(response.json.status) ? (response.json as Order) : undefined;
  }, `order ${orderId} to reach ${statuses.join(' or ')}`);

/** A price no foreign order can cross: above the best bid and below the best ask. */
const priceInsideSpread = async (): Promise<string> => {
  const depth = await call('GET', `/markets/${market}/depth`);
  assert.equal(depth.status, 200);
  const bestBid = depth.json.buys.length ? Math.max(...depth.json.buys.map((level: { price: string }) => Number(level.price))) : undefined;
  const bestAsk = depth.json.sells.length ? Math.min(...depth.json.sells.map((level: { price: string }) => Number(level.price))) : undefined;
  const low = bestBid ?? (bestAsk ?? 60_000) - 1_000;
  const high = bestAsk ?? low + 2_000;
  assert.ok(high - low >= 0.02, `spread too thin to test in isolation: ${low} .. ${high}`);
  return (Math.floor(((low + high) / 2) * 100) / 100).toFixed(2);
};

let buyer: Account;
let seller: Account;

before(async () => {
  buyer = await accountFor('buyer');
  seller = await accountFor('seller');
});

describe('Authentication through the edge', () => {
  test('Should refuse a private route without a session or with a forged Authorization', async () => {
    const anonymous = await call('POST', '/deposit', { body: { assetId: 'USD', quantity: '1' } });
    const forged = await call('GET', '/me', { headers: { authorization: 'Bearer forged' } });

    assert.equal(anonymous.status, 401);
    assert.equal(forged.status, 401);
    assert.deepEqual(forged.json, { error: 'unauthenticated' });
  });

  test("Should not let one account read another account's data", async () => {
    const foreign = await call('GET', `/accounts/${seller.accountId}`, { cookie: buyer.cookie });

    assert.equal(foreign.status, 403);
  });
});

describe('Money and orders', () => {
  test('Should show a deposit in GetAccount', async () => {
    // When
    const after = await depositAndSettle(buyer, 'USD', '1000.25');

    // Then
    assert.ok(after.available >= units('1000.25'));
  });

  test('Should trade a crossing buy and sell, settle both wallets and publish the trade in market-data', async () => {
    // Given
    const price = await priceInsideSpread();
    const quantity = '0.01';
    const cost = (units(quantity) * units(price)) / scale;
    const buyerUsd = await depositAndSettle(buyer, 'USD', '2000');
    const sellerBtc = await depositAndSettle(seller, 'BTC', '0.05');
    const buyerBtc = await balanceOf(buyer, 'BTC');
    const sellerUsd = await balanceOf(seller, 'USD');

    // When
    const sellOrderId = await placeOrder(seller, 'sell', quantity, price);
    await orderReaches(seller, sellOrderId, ['open']);
    const buyOrderId = await placeOrder(buyer, 'buy', quantity, price);

    // Then
    const buyOrder = await orderReaches(buyer, buyOrderId, ['filled']);
    await orderReaches(seller, sellOrderId, ['filled']);
    assert.equal(units(buyOrder.fillQuantity), units(quantity));
    await balanceBecomes(buyer, 'BTC', (balance) => balance.available === buyerBtc.available + units(quantity), 'buyer to receive BTC');
    await balanceBecomes(buyer, 'USD', (balance) => balance.available === buyerUsd.available - cost, 'buyer to pay USD');
    await balanceBecomes(seller, 'USD', (balance) => balance.available === sellerUsd.available + cost, 'seller to receive USD');
    await balanceBecomes(seller, 'BTC', (balance) => balance.available === sellerBtc.available - units(quantity), 'seller to deliver BTC');
    await eventually(async () => {
      const trades = await call('GET', `/markets/${market}/trades`);
      return (trades.json as Array<{ buyOrderId: string; sellOrderId: string }>).find((trade) => trade.buyOrderId === buyOrderId && trade.sellOrderId === sellOrderId);
    }, 'the trade in market-data');
  });

  test('Should reject an order the wallet cannot cover', async () => {
    // Given
    const usd = await balanceOf(buyer, 'USD');
    const price = await priceInsideSpread();
    const quantity = ((Number(usd.available / scale) + 1_000) / Number(price) + 1).toFixed(5);

    // When
    const orderId = await placeOrder(buyer, 'buy', quantity, price);

    // Then
    const order = await orderReaches(buyer, orderId, ['rejected']);
    assert.match(String(order.statusReason), /INSUFFICIENT_FUNDS/);
  });

  test('Should give the reserved balance back when an open order is cancelled', async () => {
    // Given
    const before = await depositAndSettle(buyer, 'USD', '100');
    const orderId = await placeOrder(buyer, 'buy', '0.5', '10.00');
    await orderReaches(buyer, orderId, ['open']);
    await balanceBecomes(buyer, 'USD', (balance) => balance.reserved === before.reserved + units('5'), 'the reservation');

    // When
    const cancel = await call('POST', '/cancel_order', { cookie: buyer.cookie, body: { orderId } });

    // Then
    assert.equal(cancel.status, 202);
    await orderReaches(buyer, orderId, ['cancelled']);
    await balanceBecomes(buyer, 'USD', (balance) => balance.available === before.available && balance.reserved === before.reserved, 'the reservation to return');
  });
});

describe('Logout', () => {
  test('Should end the session, after which the same cookie is refused', async () => {
    const logout = await call('POST', '/logout', { cookie: buyer.cookie });
    const after = await call('GET', '/me', { cookie: buyer.cookie });

    assert.equal(logout.status, 204);
    assert.equal(after.status, 401);
  });
});

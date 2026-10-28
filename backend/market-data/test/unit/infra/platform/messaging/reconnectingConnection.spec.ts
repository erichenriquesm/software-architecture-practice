import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import type { AmqpConnection } from '../../../../../src/infra/platform/messaging/connection.js';
import { ReconnectingConnection } from '../../../../../src/infra/platform/messaging/reconnectingConnection.js';

class FakeConnection extends EventEmitter {
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }

  drop(): void {
    this.emit('close');
  }
}

const asAmqp = (connection: FakeConnection): AmqpConnection => connection as unknown as AmqpConnection;

const scenario = (failuresBeforeSuccess: number) => {
  const connections: FakeConnection[] = [];
  const delays: number[] = [];
  let failures = failuresBeforeSuccess;
  const setups: FakeConnection[] = [];
  let teardowns = 0;
  const reconnecting = new ReconnectingConnection({
    connect: async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('ECONNREFUSED');
      }
      const connection = new FakeConnection();
      connections.push(connection);
      return asAmqp(connection);
    },
    setup: async (connection) => {
      setups.push(connection as unknown as FakeConnection);
      return async () => {
        teardowns += 1;
      };
    },
    random: () => 1,
    sleep: async (ms) => void delays.push(ms),
  });
  return { reconnecting, connections, delays, setups, teardowns: () => teardowns };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('ReconnectingConnection', () => {
  test('Should keep trying with exponential backoff until the broker accepts the connection', async () => {
    // Given
    const { reconnecting, delays, setups } = scenario(3);

    // When
    await reconnecting.start();

    // Then
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(setups).toHaveLength(1);
    expect(reconnecting.isConnected()).toBe(true);
  });

  test('Should tear down and build relay and consumers again on a new connection when the broker drops it', async () => {
    // Given
    const { reconnecting, connections, setups, teardowns } = scenario(0);
    await reconnecting.start();

    // When
    connections[0]?.drop();
    await settle();

    // Then
    expect(teardowns()).toBe(1);
    expect(setups).toHaveLength(2);
    expect(setups[1]).toBe(connections[1]);
    expect(reconnecting.isConnected()).toBe(true);
  });

  test('Should not reconnect after stop', async () => {
    // Given
    const { reconnecting, connections, setups } = scenario(0);
    await reconnecting.start();

    // When
    await reconnecting.stop();
    connections[0]?.drop();
    await settle();

    // Then
    expect(connections[0]?.closed).toBe(true);
    expect(setups).toHaveLength(1);
    expect(reconnecting.isConnected()).toBe(false);
  });
});

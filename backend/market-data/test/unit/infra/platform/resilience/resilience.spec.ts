import { describe, expect, test, vi } from 'vitest';
import { FallbackHandler } from '../../../../../src/infra/platform/resilience/fallbackHandler.js';
import { fullJitterDelay, retry } from '../../../../../src/infra/platform/resilience/retry.js';
import type { RetryPolicy } from '../../../../../src/infra/platform/resilience/retry.js';
import { TimeoutError, withTimeout } from '../../../../../src/infra/platform/resilience/timeout.js';

const policy: RetryPolicy = { baseMs: 100, capMs: 2_000, maxAttempts: 3 };

class TransientError extends Error {}
class PermanentError extends Error {}

const isTransient = (error: unknown): boolean => error instanceof TransientError;
const noSleep = async (): Promise<void> => undefined;

describe('fullJitterDelay', () => {
  test('Should stay between zero and base * 2^attempt', () => {
    expect(fullJitterDelay(policy, 1, () => 0)).toBe(0);
    expect(fullJitterDelay(policy, 1, () => 0.999999)).toBe(199);
    expect(fullJitterDelay(policy, 3, () => 0.5)).toBe(400);
  });

  test('Should never exceed the cap', () => {
    expect(fullJitterDelay(policy, 10, () => 0.999999)).toBe(1_999);
  });
});

describe('retry', () => {
  test('Should retry a transient failure and return the first success', async () => {
    // Given
    const operation = vi.fn().mockRejectedValueOnce(new TransientError()).mockResolvedValueOnce('ok');
    const sleep = vi.fn(noSleep);

    // When
    const result = await retry(operation, policy, { isTransient, sleep, random: () => 0.5 });

    // Then
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  test('Should not retry a permanent failure', async () => {
    // Given
    const operation = vi.fn().mockRejectedValue(new PermanentError('invalid'));

    // When & Then
    await expect(retry(operation, policy, { isTransient, sleep: noSleep })).rejects.toThrowError('invalid');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('Should give up after the maximum number of attempts', async () => {
    // Given
    const operation = vi.fn().mockRejectedValue(new TransientError('still down'));

    // When & Then
    await expect(retry(operation, policy, { isTransient, sleep: noSleep })).rejects.toThrowError('still down');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('withTimeout', () => {
  test('Should return the result when the operation finishes in time', async () => {
    await expect(withTimeout(async () => 'done', 100)).resolves.toBe('done');
  });

  test('Should reject with TimeoutError and abort the operation when it takes too long', async () => {
    // Given
    vi.useFakeTimers();
    let aborted = false;
    const slow = (signal: AbortSignal): Promise<string> =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => (aborted = true));
        setTimeout(() => resolve('late'), 1_000);
      });

    // When
    const result = withTimeout(slow, 500);
    vi.advanceTimersByTime(500);

    // Then
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });
});

class FixedHandler extends FallbackHandler<string, string> {
  constructor(
    private readonly answer: string | Error,
    next?: FallbackHandler<string, string>,
  ) {
    super(next);
  }

  protected async tryHandle(input: string): Promise<string> {
    if (this.answer instanceof Error) throw this.answer;
    return `${this.answer}:${input}`;
  }
}

describe('FallbackHandler', () => {
  test('Should answer with the first link that succeeds', async () => {
    // Given
    const chain = new FixedHandler(new Error('down'), new FixedHandler('second'));

    // When & Then
    await expect(chain.handle('x')).resolves.toBe('second:x');
  });

  test('Should rethrow the last error when every link fails', async () => {
    // Given
    const chain = new FixedHandler(new Error('first'), new FixedHandler(new Error('last')));

    // When & Then
    await expect(chain.handle('x')).rejects.toThrowError('last');
  });
});

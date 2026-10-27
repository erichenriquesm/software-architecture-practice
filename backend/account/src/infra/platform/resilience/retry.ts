export interface RetryPolicy {
  readonly baseMs: number;
  readonly capMs: number;
  readonly maxAttempts: number;
}

export interface RetryDependencies {
  readonly isTransient: (error: unknown) => boolean;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const grpcRetryPolicy: RetryPolicy = { baseMs: 100, capMs: 2_000, maxAttempts: 3 };

export const fullJitterDelay = (policy: RetryPolicy, attempt: number, random: () => number): number =>
  Math.floor(random() * Math.min(policy.capMs, policy.baseMs * 2 ** attempt));

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async <T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  dependencies: RetryDependencies,
): Promise<T> => {
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const exhausted = attempt >= policy.maxAttempts;
      if (exhausted || !dependencies.isTransient(error)) throw error;
      await sleep(fullJitterDelay(policy, attempt, random));
    }
  }
};

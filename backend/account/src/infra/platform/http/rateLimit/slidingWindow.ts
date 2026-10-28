export interface RateLimitPolicy {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly retryAfterSeconds: number;
  readonly policy: RateLimitPolicy;
}

export interface WindowPosition {
  readonly currentBucketStart: number;
  readonly previousBucketStart: number;
  readonly elapsedMs: number;
}

export const windowPosition = (nowMs: number, windowMs: number): WindowPosition => {
  const currentBucketStart = Math.floor(nowMs / windowMs) * windowMs;
  return { currentBucketStart, previousBucketStart: currentBucketStart - windowMs, elapsedMs: nowMs - currentBucketStart };
};

export interface SlidingWindowInput {
  readonly previousCount: number;
  readonly currentCount: number;
  readonly elapsedMs: number;
  readonly cost: number;
  readonly policy: RateLimitPolicy;
}

export const decide = (input: SlidingWindowInput): RateLimitDecision => {
  const { policy } = input;
  const previousWeight = (policy.windowMs - input.elapsedMs) / policy.windowMs;
  const estimated = input.previousCount * previousWeight + input.currentCount;
  const allowed = estimated + input.cost <= policy.limit;
  const resetSeconds = Math.ceil((policy.windowMs - input.elapsedMs) / 1_000);
  const remaining = Math.max(0, Math.floor(policy.limit - estimated - (allowed ? input.cost : 0)));
  return { allowed, remaining, resetSeconds, retryAfterSeconds: allowed ? 0 : Math.max(1, resetSeconds), policy };
};

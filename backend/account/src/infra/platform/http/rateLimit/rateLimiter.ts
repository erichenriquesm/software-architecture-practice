import type { Redis } from 'ioredis';
import { FallbackHandler } from '../../resilience/fallbackHandler.js';
import type { RateLimitDecision, RateLimitPolicy } from './slidingWindow.js';
import { decide, windowPosition } from './slidingWindow.js';

export interface RateLimitCheck {
  readonly subject: string;
  readonly policy: RateLimitPolicy;
  readonly cost: number;
  readonly nowMs: number;
}

export interface RateLimiter {
  check(check: RateLimitCheck): Promise<RateLimitDecision>;
}

const bucketKey = (prefix: string, check: RateLimitCheck, bucketStart: number): string =>
  `${prefix}:rl:${check.policy.name}:${check.subject}:${bucketStart}`;

export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  async check(check: RateLimitCheck): Promise<RateLimitDecision> {
    const position = windowPosition(check.nowMs, check.policy.windowMs);
    const currentKey = bucketKey(this.prefix, check, position.currentBucketStart);
    const decision = decide({
      previousCount: this.counts.get(bucketKey(this.prefix, check, position.previousBucketStart)) ?? 0,
      currentCount: this.counts.get(currentKey) ?? 0,
      elapsedMs: position.elapsedMs,
      cost: check.cost,
      policy: check.policy,
    });
    if (decision.allowed) this.counts.set(currentKey, (this.counts.get(currentKey) ?? 0) + check.cost);
    return decision;
  }
}

const slidingWindowScript = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local elapsed = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
if previous * ((window - elapsed) / window) + current + cost > limit then
  return {0, current, previous}
end
redis.call('INCRBY', KEYS[1], cost)
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, current, previous}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async check(check: RateLimitCheck): Promise<RateLimitDecision> {
    const position = windowPosition(check.nowMs, check.policy.windowMs);
    const reply = (await this.redis.eval(
      slidingWindowScript,
      2,
      bucketKey(this.prefix, check, position.currentBucketStart),
      bucketKey(this.prefix, check, position.previousBucketStart),
      position.elapsedMs,
      check.policy.windowMs,
      check.policy.limit,
      check.cost,
    )) as [number, number, number];
    const [, currentCount, previousCount] = reply;
    return decide({ previousCount, currentCount, elapsedMs: position.elapsedMs, cost: check.cost, policy: check.policy });
  }
}

class RateLimiterLink extends FallbackHandler<RateLimitCheck, RateLimitDecision> {
  constructor(
    private readonly limiter: RateLimiter,
    next?: RateLimiterLink,
  ) {
    super(next);
  }

  protected tryHandle(check: RateLimitCheck): Promise<RateLimitDecision> {
    return this.limiter.check(check);
  }
}

export class FallbackRateLimiter implements RateLimiter {
  private readonly chain: RateLimiterLink;

  constructor(primary: RateLimiter, fallback: RateLimiter) {
    this.chain = new RateLimiterLink(primary, new RateLimiterLink(fallback));
  }

  check(check: RateLimitCheck): Promise<RateLimitDecision> {
    return this.chain.handle(check);
  }
}

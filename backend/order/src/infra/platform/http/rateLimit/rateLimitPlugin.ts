import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from './rateLimiter.js';
import type { RateLimitDecision, RateLimitPolicy } from './slidingWindow.js';

export interface SubjectLimit extends Omit<RateLimitPolicy, 'name'> {
  readonly label: string;
  readonly subjectOf: (request: FastifyRequest) => string | undefined;
}

export interface RateLimitGroup {
  readonly name: string;
  readonly matches: (request: FastifyRequest) => boolean;
  readonly perIp: Omit<RateLimitPolicy, 'name'>;
  /** One or more limits per subject (e.g. per account per 10 s and per account per 24 h). */
  readonly perSubject?: SubjectLimit | readonly SubjectLimit[];
  readonly costOf?: (request: FastifyRequest) => number;
}

export interface RateLimitOptions {
  readonly limiter: RateLimiter;
  readonly groups: readonly RateLimitGroup[];
  readonly now?: () => number;
}

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const policyHeader = (decision: RateLimitDecision): string =>
  `"${decision.policy.name}";q=${decision.policy.limit};w=${Math.round(decision.policy.windowMs / 1_000)}`;

const stateHeader = (decision: RateLimitDecision): string =>
  `"${decision.policy.name}";r=${decision.remaining};t=${decision.resetSeconds}`;

const tightest = (first: RateLimitDecision, others: readonly RateLimitDecision[]): RateLimitDecision =>
  others.reduce((current, candidate) => {
    if (current.allowed !== candidate.allowed) return current.allowed ? candidate : current;
    return candidate.remaining < current.remaining ? candidate : current;
  }, first);

const checksFor = (request: FastifyRequest, group: RateLimitGroup, options: RateLimitOptions) => {
  const cost = group.costOf?.(request) ?? 1;
  const nowMs = (options.now ?? Date.now)();
  const checks = [{ subject: `ip:${request.ip}`, policy: { name: `${group.name}Ip`, ...group.perIp }, cost, nowMs }];
  const limits: readonly SubjectLimit[] = group.perSubject === undefined ? [] : ([] as SubjectLimit[]).concat(group.perSubject);
  for (const limit of limits) {
    const subject = limit.subjectOf(request);
    if (!subject) continue;
    const policy = { name: `${group.name}${capitalize(limit.label)}`, limit: limit.limit, windowMs: limit.windowMs };
    checks.push({ subject: `${limit.label}:${subject}`, policy, cost, nowMs });
  }
  return checks;
};

export const registerRateLimit = (app: FastifyInstance, options: RateLimitOptions): void => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const group = options.groups.find((candidate) => candidate.matches(request));
    if (!group) return;

    const [first, ...others] = await Promise.all(checksFor(request, group, options).map((check) => options.limiter.check(check)));
    if (!first) return;
    const decisions = [first, ...others];
    const decision = tightest(first, others);
    reply.header('RateLimit-Policy', decisions.map(policyHeader).join(', '));
    reply.header('RateLimit', stateHeader(decision));
    if (decision.allowed) return;

    reply.header('Retry-After', String(decision.retryAfterSeconds));
    return reply.status(429).send({ error: 'tooManyRequests' });
  });
};

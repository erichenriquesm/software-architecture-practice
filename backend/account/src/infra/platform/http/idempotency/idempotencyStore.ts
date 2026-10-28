import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../../database/database.js';

export type BeginResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'replay'; readonly statusCode: number; readonly body: unknown }
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'mismatch' };

export interface IdempotencyStore {
  begin(scope: string, key: string, requestHash: string, ttlMs: number): Promise<BeginResult>;
  complete(scope: string, key: string, statusCode: number, body: unknown): Promise<void>;
  release(scope: string, key: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Kysely<Database>) {}

  async begin(scope: string, key: string, requestHash: string, ttlMs: number): Promise<BeginResult> {
    const inserted = await this.db
      .insertInto('idempotency_key')
      .values({
        scope,
        key,
        request_hash: requestHash,
        state: 'inProgress',
        status_code: null,
        response_body: null,
        expires_at: sql<Date>`now() + ${`${ttlMs} milliseconds`}::interval`,
      })
      .onConflict((conflict) => conflict.columns(['scope', 'key']).doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1) return { kind: 'started' };

    const existing = await this.db
      .selectFrom('idempotency_key')
      .select(['request_hash', 'state', 'status_code', 'response_body'])
      .where('scope', '=', scope)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    if (existing.request_hash !== requestHash) return { kind: 'mismatch' };
    if (existing.state !== 'completed') return { kind: 'inProgress' };
    return { kind: 'replay', statusCode: Number(existing.status_code), body: existing.response_body };
  }

  async complete(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_key')
      .set({ state: 'completed', status_code: statusCode, response_body: JSON.stringify(body ?? null) })
      .where('scope', '=', scope)
      .where('key', '=', key)
      .execute();
  }

  async release(scope: string, key: string): Promise<void> {
    await this.db.deleteFrom('idempotency_key').where('scope', '=', scope).where('key', '=', key).execute();
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.db.deleteFrom('idempotency_key').where('expires_at', '<', now).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

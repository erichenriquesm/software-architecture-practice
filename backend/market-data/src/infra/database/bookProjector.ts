import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { BookLevel } from '../../application/calculations/aggregateDepth.js';
import { aggregateDepth } from '../../application/calculations/aggregateDepth.js';
import type { DepthPrecisionRange, MarketCatalog } from '../../application/contracts/marketCatalog.js';
import { MarketNotFoundError } from '../../application/errors.js';
import type { Database } from './database.js';

export interface BookSnapshot {
  readonly marketId: string;
  readonly sequence: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

interface DepthRow {
  readonly market_id: string;
  readonly precision: number;
  readonly side: string;
  readonly price: string;
  readonly quantity: string;
}

// Postgres accepts at most 65535 bind parameters per statement (5 per row here).
const rowsPerInsert = 1_000;

const precisionsOf = (range: DepthPrecisionRange): number[] => Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index);

const depthRows = (snapshot: BookSnapshot, range: DepthPrecisionRange): DepthRow[] =>
  precisionsOf(range).flatMap((precision) => [
    ...aggregateDepth(snapshot.bids, precision, 'buy').map((level) => ({ market_id: snapshot.marketId, precision, side: 'buy', ...level })),
    ...aggregateDepth(snapshot.asks, precision, 'sell').map((level) => ({ market_id: snapshot.marketId, precision, side: 'sell', ...level })),
  ]);

/** book_state_view and depth_view of a matching.bookSnapshot, last-write-wins by sequence. */
export class BookProjector {
  constructor(private readonly marketCatalog: MarketCatalog) {}

  /** Returns whether the snapshot was newer than the one already applied (and so replaced it). */
  async project(trx: Transaction<Database>, snapshot: BookSnapshot, occurredAt: Date): Promise<boolean> {
    const range = this.marketCatalog.depthPrecisionOf(snapshot.marketId);
    if (!range) throw new MarketNotFoundError(snapshot.marketId);
    if (!(await this.replaceState(trx, snapshot, range, occurredAt))) return false;
    await trx.deleteFrom('depth_view').where('market_id', '=', snapshot.marketId).execute();
    const rows = depthRows(snapshot, range);
    for (let start = 0; start < rows.length; start += rowsPerInsert) {
      await trx.insertInto('depth_view').values(rows.slice(start, start + rowsPerInsert)).execute();
    }
    return true;
  }

  /** The upsert locks the market row until commit, so concurrent snapshots line up and an older one loses. */
  private async replaceState(trx: Transaction<Database>, snapshot: BookSnapshot, range: DepthPrecisionRange, occurredAt: Date): Promise<boolean> {
    const result = await trx
      .insertInto('book_state_view')
      .values({
        market_id: snapshot.marketId,
        sequence: snapshot.sequence,
        best_bid: aggregateDepth(snapshot.bids, range.min, 'buy')[0]?.price ?? null,
        best_ask: aggregateDepth(snapshot.asks, range.min, 'sell')[0]?.price ?? null,
        updated_at: occurredAt,
      })
      .onConflict((conflict) =>
        conflict
          .column('market_id')
          .doUpdateSet({
            sequence: sql`excluded.sequence`,
            best_bid: sql`excluded.best_bid`,
            best_ask: sql`excluded.best_ask`,
            updated_at: sql`excluded.updated_at`,
          })
          .where(sql<boolean>`book_state_view.sequence < excluded.sequence`),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }
}

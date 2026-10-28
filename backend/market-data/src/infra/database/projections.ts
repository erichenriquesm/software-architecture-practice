import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from './database.js';

/** Every projection is disposable: the rebuild empties them all in one transaction and replays the stream. */
export const truncateProjections = async (db: Kysely<Database>): Promise<void> => {
  await sql`truncate table trade_view, candle_1m_view, book_state_view, depth_view`.execute(db);
};

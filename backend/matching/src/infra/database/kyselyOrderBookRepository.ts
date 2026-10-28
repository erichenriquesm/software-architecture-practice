import type { Selectable } from 'kysely';
import type { OrderBookRepository } from '../../application/contracts/orderBookRepository.js';
import { BookEntry } from '../../domain/entities/bookEntry.js';
import { OrderBook } from '../../domain/entities/orderBook.js';
import type { Trade } from '../../domain/valueObjects/trade.js';
import { ConcurrentBookUpdateError } from '../../domain/errors.js';
import { AccountId } from '../../domain/valueObjects/accountId.js';
import type { MarketId } from '../../domain/valueObjects/marketId.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { BookEntryTable, Database } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';

const entryOf = (row: Selectable<BookEntryTable>): BookEntry =>
  BookEntry.of({
    orderId: OrderId.from(row.order_id),
    accountId: AccountId.from(row.account_id),
    side: Side.from(row.side),
    price: Price.from(row.price),
    remaining: Quantity.from(row.remaining),
    priority: Number(row.priority),
    acceptedAt: row.accepted_at,
  });

const entryRow = (marketId: MarketId, entry: BookEntry) => {
  const data = entry.snapshot;
  return {
    order_id: data.orderId.value,
    market_id: marketId.value,
    account_id: data.accountId.value,
    side: data.side.value,
    price: data.price.toString(),
    remaining: data.remaining.toString(),
    priority: data.priority,
    accepted_at: data.acceptedAt,
  };
};

const tradeRow = (trade: Trade) => ({
  trade_id: trade.tradeId,
  market_id: trade.marketId.value,
  buy_order_id: trade.buyOrderId.value,
  sell_order_id: trade.sellOrderId.value,
  buy_account_id: trade.buyAccountId.value,
  sell_account_id: trade.sellAccountId.value,
  side: trade.side.value,
  quantity: trade.quantity.toString(),
  price: trade.price.toString(),
  executed_at: trade.executedAt,
  book_sequence: trade.bookSequence,
});

/** The database is the truth: the book is loaded on every message and saved with a sequence check. */
export class KyselyOrderBookRepository implements OrderBookRepository {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async load(marketId: MarketId): Promise<OrderBook> {
    const db = this.runner.executor();
    const book = await db.selectFrom('book').selectAll().where('market_id', '=', marketId.value).executeTakeFirst();
    if (!book) return OrderBook.empty(marketId);
    const entries = await db.selectFrom('book_entry').selectAll().where('market_id', '=', marketId.value).orderBy('priority').execute();
    return OrderBook.restore({ marketId, sequence: Number(book.sequence), nextPriority: Number(book.next_priority), entries: entries.map(entryOf) });
  }

  async save(book: OrderBook): Promise<void> {
    const saved = book.isNew() ? await this.insertBook(book) : await this.advanceBook(book);
    if (!saved) throw new ConcurrentBookUpdateError(book.marketId.value);
    const { upserted, deleted, trades } = book.changes();
    const db = this.runner.executor();
    if (deleted.length > 0) await db.deleteFrom('book_entry').where('order_id', 'in', deleted).execute();
    if (upserted.length > 0) {
      await db
        .insertInto('book_entry')
        .values(upserted.map((entry) => entryRow(book.marketId, entry)))
        .onConflict((conflict) => conflict.column('order_id').doUpdateSet((excluded) => ({ remaining: excluded.ref('excluded.remaining') })))
        .execute();
    }
    if (trades.length > 0) await db.insertInto('trade').values(trades.map(tradeRow)).execute();
  }

  private async insertBook(book: OrderBook): Promise<boolean> {
    const result = await this.runner
      .executor()
      .insertInto('book')
      .values({ market_id: book.marketId.value, sequence: book.sequence, next_priority: book.nextPriority })
      .onConflict((conflict) => conflict.column('market_id').doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  private async advanceBook(book: OrderBook): Promise<boolean> {
    const result = await this.runner
      .executor()
      .updateTable('book')
      .set({ sequence: book.sequence, next_priority: book.nextPriority })
      .where('market_id', '=', book.marketId.value)
      .where('sequence', '=', String(book.savedSequence))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }
}

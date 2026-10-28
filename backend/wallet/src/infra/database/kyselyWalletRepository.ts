import type { WalletRepository } from '../../application/contracts/walletRepository.js';
import { Reservation } from '../../domain/entities/reservation.js';
import type { ReservationStatus } from '../../domain/entities/reservation.js';
import { Wallet } from '../../domain/entities/wallet.js';
import { ConcurrentWalletUpdateError } from '../../domain/errors.js';
import type { AccountId } from '../../domain/valueObjects/accountId.js';
import { AssetId } from '../../domain/valueObjects/assetId.js';
import { Balance } from '../../domain/valueObjects/balance.js';
import { OrderId } from '../../domain/valueObjects/orderId.js';
import { Price } from '../../domain/valueObjects/price.js';
import { Quantity } from '../../domain/valueObjects/quantity.js';
import { Side } from '../../domain/valueObjects/side.js';
import type { Database } from './database.js';
import type { KyselyTransactionRunner } from './kyselyTransactionRunner.js';

interface ReservationRow {
  readonly order_id: string;
  readonly asset_id: string;
  readonly side: string;
  readonly limit_price: string;
  readonly remaining: string;
  readonly status: string;
  readonly created_at: Date;
}

const reservationOf = (row: ReservationRow): Reservation =>
  Reservation.restore({
    orderId: OrderId.from(row.order_id),
    assetId: AssetId.from(row.asset_id),
    side: Side.from(row.side),
    limitPrice: Price.from(row.limit_price),
    remaining: Quantity.from(row.remaining),
    status: row.status as ReservationStatus,
    createdAt: row.created_at,
  });

/** Loads a wallet with its balances and open reservations; saves it with an optimistic version check. */
export class KyselyWalletRepository implements WalletRepository {
  constructor(private readonly runner: KyselyTransactionRunner<Database>) {}

  async findByAccount(accountId: AccountId): Promise<Wallet | undefined> {
    const db = this.runner.executor();
    const wallet = await db.selectFrom('wallet').select('version').where('account_id', '=', accountId.value).executeTakeFirst();
    if (!wallet) return undefined;

    const balances = await db.selectFrom('balance').selectAll().where('account_id', '=', accountId.value).execute();
    const reservations = await db
      .selectFrom('reservation')
      .selectAll()
      .where('account_id', '=', accountId.value)
      .where('status', '=', 'open')
      .execute();
    return Wallet.restore({
      accountId,
      version: Number(wallet.version),
      balances: new Map(balances.map((row) => [row.asset_id, Balance.of(Quantity.from(row.available), Quantity.from(row.reserved))])),
      reservations: reservations.map(reservationOf),
    });
  }

  async save(wallet: Wallet): Promise<void> {
    await this.saveVersion(wallet);
    await this.saveBalances(wallet);
    await this.saveReservations(wallet);
    await this.appendLedger(wallet);
  }

  private async saveVersion(wallet: Wallet): Promise<void> {
    const saved = wallet.isNew() ? await this.insertWallet(wallet) : await this.bumpVersion(wallet);
    if (!saved) throw new ConcurrentWalletUpdateError(wallet.accountId.value);
  }

  private async insertWallet(wallet: Wallet): Promise<boolean> {
    const result = await this.runner
      .executor()
      .insertInto('wallet')
      .values({ account_id: wallet.accountId.value, version: wallet.nextVersion })
      .onConflict((conflict) => conflict.column('account_id').doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  private async bumpVersion(wallet: Wallet): Promise<boolean> {
    const result = await this.runner
      .executor()
      .updateTable('wallet')
      .set({ version: wallet.nextVersion })
      .where('account_id', '=', wallet.accountId.value)
      .where('version', '=', String(wallet.version))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  private async saveBalances(wallet: Wallet): Promise<void> {
    const rows = [...wallet.allBalances().entries()].map(([assetId, balance]) => ({
      account_id: wallet.accountId.value,
      asset_id: assetId,
      available: balance.available.toString(),
      reserved: balance.reserved.toString(),
    }));
    if (rows.length === 0) return;
    await this.runner
      .executor()
      .insertInto('balance')
      .values(rows)
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'asset_id']).doUpdateSet((excluded) => ({
          available: excluded.ref('excluded.available'),
          reserved: excluded.ref('excluded.reserved'),
        })),
      )
      .execute();
  }

  private async saveReservations(wallet: Wallet): Promise<void> {
    const rows = wallet.allReservations().map(({ snapshot }) => ({
      order_id: snapshot.orderId.value,
      account_id: wallet.accountId.value,
      asset_id: snapshot.assetId.value,
      side: snapshot.side.value,
      limit_price: snapshot.limitPrice.toString(),
      remaining: snapshot.remaining.toString(),
      status: snapshot.status,
      created_at: snapshot.createdAt,
    }));
    if (rows.length === 0) return;
    await this.runner
      .executor()
      .insertInto('reservation')
      .values(rows)
      .onConflict((conflict) =>
        conflict.column('order_id').doUpdateSet((excluded) => ({
          remaining: excluded.ref('excluded.remaining'),
          status: excluded.ref('excluded.status'),
        })),
      )
      .execute();
  }

  private async appendLedger(wallet: Wallet): Promise<void> {
    const rows = wallet.pendingLedger().map((entry) => ({
      account_id: wallet.accountId.value,
      asset_id: entry.assetId,
      available_delta: entry.availableDelta,
      reserved_delta: entry.reservedDelta,
      reason: entry.reason,
      reference_id: entry.referenceId,
      wallet_version: wallet.nextVersion,
      created_at: entry.createdAt,
    }));
    if (rows.length === 0) return;
    await this.runner.executor().insertInto('ledger_entry').values(rows).execute();
  }
}

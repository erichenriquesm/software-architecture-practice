export type LedgerReason = 'DEPOSIT' | 'WITHDRAW' | 'RESERVE' | 'SETTLE' | 'RELEASE' | 'VOID';

/** One append-only line of the audit trail: what moved in available and reserved, and why. */
export interface LedgerEntry {
  readonly assetId: string;
  readonly availableDelta: string;
  readonly reservedDelta: string;
  readonly reason: LedgerReason;
  readonly referenceId: string | null;
  readonly createdAt: Date;
}

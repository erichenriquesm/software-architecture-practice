export interface TradeStatsView {
  readonly min: string | null;
  readonly max: string | null;
  readonly volume: string;
}

export interface TopOfBookView {
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly updatedAt: Date;
}

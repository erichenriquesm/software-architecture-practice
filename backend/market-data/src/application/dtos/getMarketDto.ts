export interface GetMarketInput {
  readonly marketId: string;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
}

export interface GetMarketOutput {
  readonly spread: string | null;
  readonly min: string | null;
  readonly max: string | null;
  readonly volume: string;
  readonly asOf: string | null;
}

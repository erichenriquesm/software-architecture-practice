export interface GetTradesInput {
  readonly marketId: string;
  readonly limit?: number | undefined;
  /** Only trades executed strictly before this ISO 8601 instant (pagination). */
  readonly before?: string | undefined;
}

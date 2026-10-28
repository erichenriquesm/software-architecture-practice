export class MarketNotFoundError extends Error {
  constructor(readonly marketId: string) {
    super(`Market ${marketId} does not exist`);
    this.name = 'MarketNotFoundError';
  }
}

export class InvalidQueryError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'InvalidQueryError';
  }
}

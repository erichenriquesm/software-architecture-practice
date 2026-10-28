export class InvalidBookDataError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'InvalidBookDataError';
  }
}

export class ConcurrentBookUpdateError extends Error {
  constructor(readonly marketId: string) {
    super(`book ${marketId} was changed by someone else`);
    this.name = 'ConcurrentBookUpdateError';
  }
}

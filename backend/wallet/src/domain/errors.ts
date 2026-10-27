export class InvalidWalletDataError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'InvalidWalletDataError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(readonly assetId: string) {
    super(`insufficient available ${assetId}`);
    this.name = 'InsufficientFundsError';
  }
}

export class ReservationNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`no open reservation for order ${orderId}`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationExceededError extends Error {
  constructor(readonly orderId: string) {
    super(`reservation of order ${orderId} cannot cover the requested amount`);
    this.name = 'ReservationExceededError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} not found`);
    this.name = 'AccountNotFoundError';
  }
}

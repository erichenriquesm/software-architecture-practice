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

export class WalletNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} has no wallet and does not exist`);
    this.name = 'WalletNotFoundError';
  }
}

export class ReservationNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`no open reservation for order ${orderId}`);
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationOverdrawnError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} tried to use more than its reservation`);
    this.name = 'ReservationOverdrawnError';
  }
}

export class ConcurrentWalletUpdateError extends Error {
  constructor(readonly accountId: string) {
    super(`wallet ${accountId} was changed by someone else`);
    this.name = 'ConcurrentWalletUpdateError';
  }
}

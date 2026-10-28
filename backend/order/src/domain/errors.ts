export class InvalidOrderDataError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'InvalidOrderDataError';
  }
}

export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly orderId: string,
    reason: string,
  ) {
    super(`order ${orderId}: ${reason}`);
    this.name = 'InvalidOrderTransitionError';
  }
}

export class FillExceedsQuantityError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} would be filled above its quantity`);
    this.name = 'FillExceedsQuantityError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} not found`);
    this.name = 'OrderNotFoundError';
  }
}

export class NotOrderOwnerError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} belongs to another account`);
    this.name = 'NotOrderOwnerError';
  }
}

export class ConcurrentOrderUpdateError extends Error {
  constructor(readonly orderId: string) {
    super(`order ${orderId} was changed by someone else`);
    this.name = 'ConcurrentOrderUpdateError';
  }
}

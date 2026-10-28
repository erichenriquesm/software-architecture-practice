export class InvalidAccountDataError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'InvalidAccountDataError';
  }
}

export class DuplicateEmailError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'DuplicateEmailError';
  }
}

export class AccountNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} not found`);
    this.name = 'AccountNotFoundError';
  }
}

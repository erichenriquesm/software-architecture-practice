const kebabCase = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class InvalidServiceNameError extends Error {
  constructor(readonly value: string) {
    super(`Invalid service name: ${value}`);
    this.name = 'InvalidServiceNameError';
  }
}

export class ServiceName {
  private constructor(readonly value: string) {}

  static from(value: string): ServiceName {
    if (!kebabCase.test(value)) throw new InvalidServiceNameError(value);
    return new ServiceName(value);
  }
}

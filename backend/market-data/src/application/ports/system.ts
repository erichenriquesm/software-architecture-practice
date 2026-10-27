export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

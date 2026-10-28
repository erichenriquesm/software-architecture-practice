import { InvalidAccountDataError } from '../errors.js';

const checkDigit = (digits: readonly number[], weightStart: number): number => {
  const sum = digits.reduce((total, digit, index) => total + digit * (weightStart - index), 0);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
};

export class Cpf {
  private constructor(readonly value: string) {}

  static from(value: string): Cpf {
    const digitsOnly = value.replace(/\D/g, '');
    if (digitsOnly.length !== 11 || /^(\d)\1{10}$/.test(digitsOnly)) throw new InvalidAccountDataError('document', 'must be a valid CPF');
    const digits = [...digitsOnly].map(Number);
    const first = checkDigit(digits.slice(0, 9), 10);
    const second = checkDigit(digits.slice(0, 10), 11);
    if (digits[9] !== first || digits[10] !== second) throw new InvalidAccountDataError('document', 'must be a valid CPF');
    return new Cpf(digitsOnly);
  }
}

import { argon2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordHasher } from '../../../../application/ports/accountPorts.js';
import type { Password } from '../../../../domain/valueObjects.js';
import { PasswordHash } from '../../../../domain/valueObjects.js';

const argon2Async = promisify(argon2);

export interface Argon2Parameters {
  readonly memoryKib: number;
  readonly passes: number;
  readonly parallelism: number;
}

export const owaspArgon2Parameters: Argon2Parameters = { memoryKib: 19_456, passes: 2, parallelism: 1 };

const base64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly parameters: Argon2Parameters = owaspArgon2Parameters) {}

  async hash(password: Password): Promise<PasswordHash> {
    const salt = randomBytes(16);
    const { memoryKib, passes, parallelism } = this.parameters;
    const digest = await argon2Async('argon2id', {
      message: password.value,
      nonce: salt,
      memory: memoryKib,
      passes,
      parallelism,
      tagLength: 32,
    });
    return PasswordHash.from(`$argon2id$v=19$m=${memoryKib},t=${passes},p=${parallelism}$${base64(salt)}$${base64(digest)}`);
  }
}

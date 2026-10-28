import type { Password } from '../../domain/valueObjects/password.js';
import type { PasswordHash } from '../../domain/valueObjects/passwordHash.js';

export interface PasswordHasher {
  hash(password: Password): Promise<PasswordHash>;
}

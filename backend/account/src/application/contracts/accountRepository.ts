import type { Account } from '../../domain/entities/account.js';
import type { Email } from '../../domain/valueObjects/email.js';

export interface AccountRepository {
  existsByEmail(email: Email): Promise<boolean>;
  save(account: Account): Promise<void>;
}

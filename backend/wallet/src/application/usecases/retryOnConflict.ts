import { ConcurrentWalletUpdateError } from '../../domain/errors.js';

const maxAttempts = 3;

/** Optimistic locking: when another change saved the wallet first, reload and try again (up to 3 times). */
export const retryOnConflict = <T>(work: () => Promise<T>, attempt = 1): Promise<T> =>
  work().catch((error: unknown) => {
    if (!(error instanceof ConcurrentWalletUpdateError) || attempt >= maxAttempts) throw error;
    return retryOnConflict(work, attempt + 1);
  });

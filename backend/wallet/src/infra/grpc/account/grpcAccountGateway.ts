import grpc from '@grpc/grpc-js';
import type { AccountGateway } from '../../../application/contracts/accountGateway.js';
import type { ExistsResponse } from '../../generated/account.js';
import { AccountServiceClient } from '../../generated/account.js';
import { currentCorrelation } from '../../platform/observability/correlation.js';
import type { RetryPolicy } from '../../platform/resilience/retry.js';
import { grpcRetryPolicy, retry } from '../../platform/resilience/retry.js';
import type { ServiceIdentity } from '../../platform/security/serviceAuth.js';
import { identify } from '../../platform/security/serviceAuth.js';
import { translateExists } from './accountAcl.js';

const transientCodes = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.RESOURCE_EXHAUSTED]);

const isServiceError = (error: unknown): error is grpc.ServiceError =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number';

export const isTransientGrpcError = (error: unknown): boolean => isServiceError(error) && transientCodes.has(error.code);

/** The account service could not answer after the retries: HTTP answers 503, a consumer retries later. */
export class AccountServiceUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('account service unavailable');
    this.name = 'AccountServiceUnavailableError';
  }
}

export interface AccountGatewayOptions {
  readonly address: string;
  readonly identity: ServiceIdentity;
  readonly deadlineMs?: number;
  readonly retryPolicy?: RetryPolicy;
}

export class GrpcAccountGateway implements AccountGateway {
  private readonly client: AccountServiceClient;

  constructor(private readonly options: AccountGatewayOptions) {
    this.client = new AccountServiceClient(options.address, grpc.credentials.createInsecure());
  }

  async exists(accountId: string): Promise<boolean> {
    const response = await retry(() => this.call(accountId), this.options.retryPolicy ?? grpcRetryPolicy, {
      isTransient: isTransientGrpcError,
    }).catch((error: unknown) => {
      if (isTransientGrpcError(error)) throw new AccountServiceUnavailableError(error);
      throw error;
    });
    return translateExists(response);
  }

  close(): void {
    this.client.close();
  }

  private call(accountId: string): Promise<ExistsResponse> {
    const metadata = identify(new grpc.Metadata(), this.options.identity);
    metadata.set('x-correlation-id', currentCorrelation().correlationId);
    const deadline = Date.now() + (this.options.deadlineMs ?? 500);
    return new Promise((resolve, reject) => {
      this.client.exists({ accountId }, metadata, { deadline }, (error, response) => (error ? reject(error) : resolve(response)));
    });
  }
}

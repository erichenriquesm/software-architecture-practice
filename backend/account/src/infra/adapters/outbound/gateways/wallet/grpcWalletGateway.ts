import grpc from '@grpc/grpc-js';
import type { AssetBalance } from '../../../../../application/ports/accountPorts.js';
import type { GetBalancesResponse } from '../../../../generated/wallet.js';
import { WalletServiceClient } from '../../../../generated/wallet.js';
import type { RetryPolicy } from '../../../../platform/resilience/retry.js';
import { grpcRetryPolicy, retry } from '../../../../platform/resilience/retry.js';
import { currentCorrelation } from '../../../../platform/observability/correlation.js';
import { translateWalletBalances } from './walletAcl.js';

const transientCodes = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.RESOURCE_EXHAUSTED]);

const isServiceError = (error: unknown): error is grpc.ServiceError =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number';

export const isTransientGrpcError = (error: unknown): boolean => isServiceError(error) && transientCodes.has(error.code);

export interface WalletGatewayOptions {
  readonly address: string;
  readonly credentials: grpc.ChannelCredentials;
  readonly deadlineMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly channelOptions?: grpc.ChannelOptions;
}

export class GrpcWalletGateway {
  private readonly client: WalletServiceClient;

  constructor(private readonly options: WalletGatewayOptions) {
    this.client = new WalletServiceClient(options.address, options.credentials, options.channelOptions ?? {});
  }

  async balancesOf(accountId: string): Promise<AssetBalance[]> {
    const response = await retry(() => this.call(accountId), this.options.retryPolicy ?? grpcRetryPolicy, {
      isTransient: isTransientGrpcError,
    }).catch((error: unknown) => {
      if (isServiceError(error) && error.code === grpc.status.NOT_FOUND) return { balances: [], version: 0 };
      throw error;
    });
    return translateWalletBalances(response);
  }

  close(): void {
    this.client.close();
  }

  private call(accountId: string): Promise<GetBalancesResponse> {
    const metadata = new grpc.Metadata();
    metadata.set('x-correlation-id', currentCorrelation().correlationId);
    const deadline = Date.now() + (this.options.deadlineMs ?? 500);
    return new Promise((resolve, reject) => {
      this.client.getBalances({ accountId }, metadata, { deadline }, (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }
}

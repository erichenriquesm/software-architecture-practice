import grpc from '@grpc/grpc-js';
import type { GetBalances } from '../../application/usecases/getBalances.js';
import { InvalidWalletDataError, WalletNotFoundError } from '../../domain/errors.js';
import type { WalletServiceServer } from '../generated/wallet.js';
import { WalletServiceService } from '../generated/wallet.js';
import type { AllowedCallers, DeniedCall, GrpcAllowlist } from '../platform/security/serviceAuth.js';
import { serviceAuthInterceptor, validateAllowlist } from '../platform/security/serviceAuth.js';

export const getBalancesMethod = WalletServiceService.getBalances.path;

export const walletGrpcAllowlist: GrpcAllowlist = { [getBalancesMethod]: ['account'] };

const statusFor = (error: unknown): grpc.status => {
  if (error instanceof WalletNotFoundError) return grpc.status.NOT_FOUND;
  if (error instanceof InvalidWalletDataError) return grpc.status.INVALID_ARGUMENT;
  return grpc.status.INTERNAL;
};

const implementation = (getBalances: GetBalances): WalletServiceServer => ({
  getBalances: (call, callback) => {
    getBalances
      .execute(call.request.accountId)
      .then((view) => callback(null, { balances: [...view.balances], version: view.version }))
      .catch((error: unknown) => callback({ code: statusFor(error), details: String(error) }));
  },
});

export interface WalletGrpcServerOptions {
  readonly getBalances: GetBalances;
  readonly allowedCallers: AllowedCallers;
  readonly address: string;
  readonly allowlist?: GrpcAllowlist;
  readonly onDenied?: (deniedCall: DeniedCall) => void;
}

export const startWalletGrpcServer = async (options: WalletGrpcServerOptions): Promise<{ server: grpc.Server; port: number }> => {
  const allowlist = validateAllowlist(options.allowlist ?? walletGrpcAllowlist, [getBalancesMethod]);
  const server = new grpc.Server({
    interceptors: [serviceAuthInterceptor(options.allowedCallers, allowlist, options.onDenied ?? (() => undefined))],
  });
  server.addService(WalletServiceService, implementation(options.getBalances));
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(options.address, grpc.ServerCredentials.createInsecure(), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  return { server, port };
};

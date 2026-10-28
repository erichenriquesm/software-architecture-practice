import grpc from '@grpc/grpc-js';
import type { AccountExists } from '../../application/usecases/accountExists.js';
import { InvalidAccountDataError } from '../../domain/errors.js';
import type { AccountServiceServer } from '../generated/account.js';
import { AccountServiceService } from '../generated/account.js';
import type { AllowedCallers, DeniedCall, GrpcAllowlist } from '../platform/security/serviceAuth.js';
import { serviceAuthInterceptor, validateAllowlist } from '../platform/security/serviceAuth.js';

export const existsMethod = AccountServiceService.exists.path;

export const accountGrpcAllowlist: GrpcAllowlist = { [existsMethod]: ['wallet'] };

const statusFor = (error: unknown): grpc.status =>
  error instanceof InvalidAccountDataError ? grpc.status.INVALID_ARGUMENT : grpc.status.INTERNAL;

const implementation = (accountExists: AccountExists): AccountServiceServer => ({
  exists: (call, callback) => {
    accountExists
      .execute(call.request.accountId)
      .then((exists) => callback(null, { exists }))
      .catch((error: unknown) => callback({ code: statusFor(error), details: String(error) }));
  },
});

export interface AccountGrpcServerOptions {
  readonly accountExists: AccountExists;
  readonly allowedCallers: AllowedCallers;
  readonly address: string;
  readonly allowlist?: GrpcAllowlist;
  readonly onDenied?: (deniedCall: DeniedCall) => void;
}

export const startAccountGrpcServer = async (options: AccountGrpcServerOptions): Promise<{ server: grpc.Server; port: number }> => {
  const allowlist = validateAllowlist(options.allowlist ?? accountGrpcAllowlist, [existsMethod]);
  const server = new grpc.Server({
    interceptors: [serviceAuthInterceptor(options.allowedCallers, allowlist, options.onDenied ?? (() => undefined))],
  });
  server.addService(AccountServiceService, implementation(options.accountExists));
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(options.address, grpc.ServerCredentials.createInsecure(), (error, boundPort) =>
      error ? reject(error) : resolve(boundPort),
    ),
  );
  return { server, port };
};

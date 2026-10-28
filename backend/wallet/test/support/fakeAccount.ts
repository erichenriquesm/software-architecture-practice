import grpc from '@grpc/grpc-js';
import type { AccountServiceServer } from '../../src/infra/generated/account.js';
import { AccountServiceService } from '../../src/infra/generated/account.js';
import type { AllowedCallers } from '../../src/infra/platform/security/serviceAuth.js';
import { serviceAuthInterceptor } from '../../src/infra/platform/security/serviceAuth.js';

export interface FakeAccount {
  readonly address: string;
  existing: Set<string>;
  unavailable: boolean;
  calls: number;
  stop(): void;
}

/** In-process AccountService that checks name + token like the real one (only `wallet` may call Exists). */
export const startFakeAccount = async (allowedCallers: AllowedCallers): Promise<FakeAccount> => {
  const fake: FakeAccount = { address: '', existing: new Set(), unavailable: false, calls: 0, stop: () => undefined };
  const implementation: AccountServiceServer = {
    exists: (call, callback) => {
      fake.calls += 1;
      if (fake.unavailable) {
        callback({ code: grpc.status.UNAVAILABLE, details: 'fake account down' });
        return;
      }
      callback(null, { exists: fake.existing.has(call.request.accountId) });
    },
  };
  const allowlist = { [AccountServiceService.exists.path]: ['wallet'] };
  const server = new grpc.Server({ interceptors: [serviceAuthInterceptor(allowedCallers, allowlist, () => undefined)] });
  server.addService(AccountServiceService, implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => (error ? reject(error) : resolve(boundPort))),
  );
  return Object.assign(fake, { address: `127.0.0.1:${port}`, stop: () => server.forceShutdown() });
};

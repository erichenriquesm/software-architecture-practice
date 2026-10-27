import grpc from '@grpc/grpc-js';
import type { GetBalancesResponse, WalletServiceServer } from '../../src/infra/generated/wallet.js';
import { WalletServiceService } from '../../src/infra/generated/wallet.js';
import type { TlsFiles } from '../../src/infra/platform/security/grpcCredentials.js';
import { serverCredentials } from '../../src/infra/platform/security/grpcCredentials.js';

export type FakeAnswer = GetBalancesResponse | grpc.status;

export interface FakeWallet {
  readonly address: string;
  calls: number;
  answers: FakeAnswer[];
  stop(): void;
}

export const startFakeWallet = async (tls: TlsFiles): Promise<FakeWallet> => {
  const fake: FakeWallet = { address: '', calls: 0, answers: [], stop: () => undefined };
  const implementation: WalletServiceServer = {
    getBalances: (_call, callback) => {
      fake.calls += 1;
      const answer = fake.answers.length > 1 ? fake.answers.shift() : fake.answers[0];
      if (answer === undefined || typeof answer === 'number') {
        callback({ code: answer ?? grpc.status.UNAVAILABLE, details: 'fake wallet' });
        return;
      }
      callback(null, answer);
    },
  };
  const server = new grpc.Server();
  server.addService(WalletServiceService, implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', serverCredentials(tls), (error, boundPort) => (error ? reject(error) : resolve(boundPort))),
  );
  return Object.assign(fake, { address: `127.0.0.1:${port}`, stop: () => server.forceShutdown() });
};

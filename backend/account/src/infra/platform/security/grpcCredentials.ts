import { readFileSync } from 'node:fs';
import grpc from '@grpc/grpc-js';

export interface TlsFiles {
  readonly caFile: string;
  readonly certFile: string;
  readonly keyFile: string;
}

export const tlsFilesFromEnv = (env: NodeJS.ProcessEnv = process.env): TlsFiles => ({
  caFile: String(env.TLS_CA_FILE),
  certFile: String(env.TLS_CERT_FILE),
  keyFile: String(env.TLS_KEY_FILE),
});

export const serverCredentials = (files: TlsFiles): grpc.ServerCredentials =>
  grpc.ServerCredentials.createSsl(
    readFileSync(files.caFile),
    [{ private_key: readFileSync(files.keyFile), cert_chain: readFileSync(files.certFile) }],
    true,
  );

export const clientCredentials = (files: TlsFiles): grpc.ChannelCredentials =>
  grpc.credentials.createSsl(readFileSync(files.caFile), readFileSync(files.keyFile), readFileSync(files.certFile));

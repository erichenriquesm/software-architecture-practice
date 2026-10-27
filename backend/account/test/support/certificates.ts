import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TlsFiles } from '../../src/infra/platform/security/grpcCredentials.js';

const openssl = (args: readonly string[], cwd: string): void => {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
};

export interface TestCa {
  readonly directory: string;
  readonly caFile: string;
  issue(subjectAltName: string): TlsFiles;
}

export const createTestCa = (name = 'test-ca'): TestCa => {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'], directory);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '1', '-subj', `/CN=${name}`, '-out', 'ca.crt'], directory);

  const issue = (subjectAltName: string): TlsFiles => {
    const id = subjectAltName.replace(/[^a-z0-9]/gi, '_');
    writeFileSync(
      join(directory, `${id}.ext`),
      `subjectAltName=${subjectAltName}\nextendedKeyUsage=serverAuth,clientAuth\nkeyUsage=digitalSignature\n`,
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${id}.key`], directory);
    openssl(['req', '-new', '-key', `${id}.key`, '-subj', `/CN=${id}`, '-out', `${id}.csr`], directory);
    openssl(
      ['x509', '-req', '-in', `${id}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-sha256', '-extfile', `${id}.ext`, '-out', `${id}.crt`],
      directory,
    );
    return { caFile: join(directory, 'ca.crt'), certFile: join(directory, `${id}.crt`), keyFile: join(directory, `${id}.key`) };
  };

  return { directory, caFile: join(directory, 'ca.crt'), issue };
};

import grpc from '@grpc/grpc-js';

export type GrpcAllowlist = Readonly<Record<string, readonly string[]>>;

export interface DeniedCall {
  readonly caller: string | null;
  readonly method: string;
  readonly correlationId: string | null;
}

export class InvalidAllowlistError extends Error {
  constructor(reason: string) {
    super(`Invalid gRPC allowlist: ${reason}`);
    this.name = 'InvalidAllowlistError';
  }
}

const serviceSan = /^DNS:([a-z][a-z0-9-]*)-api$/;
const methodPath = /^\/[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/;

export const serviceFromSan = (subjectAltName: string | undefined): string | null => {
  const names = (subjectAltName ?? '').split(',').map((name) => name.trim());
  const match = names.map((name) => serviceSan.exec(name)).find((result) => result !== null);
  return match?.[1] ?? null;
};

export const validateAllowlist = (allowlist: GrpcAllowlist, servedMethods: readonly string[]): GrpcAllowlist => {
  const unknown = Object.keys(allowlist).filter((method) => !servedMethods.includes(method));
  if (unknown.length > 0) throw new InvalidAllowlistError(`unknown methods ${unknown.join(', ')}`);
  const malformed = Object.keys(allowlist).filter((method) => !methodPath.test(method));
  if (malformed.length > 0) throw new InvalidAllowlistError(`malformed methods ${malformed.join(', ')}`);
  return allowlist;
};

const isAllowed = (allowlist: GrpcAllowlist, method: string, caller: string | null): boolean =>
  caller !== null && (allowlist[method] ?? []).includes(caller);

export const allowlistInterceptor =
  (allowlist: GrpcAllowlist, onDenied: (deniedCall: DeniedCall) => void): grpc.ServerInterceptor =>
  (methodDescriptor, call) => {
    const caller = serviceFromSan(call.getAuthContext()?.sslPeerCertificate?.subjectaltname);
    const allowed = isAllowed(allowlist, methodDescriptor.path, caller);

    return new grpc.ServerInterceptingCall(call, {
      start: (next) =>
        next({
          onReceiveMetadata: (metadata, metadataNext) => {
            if (allowed) return metadataNext(metadata);
            const correlationId = String(metadata.get('x-correlation-id')[0] ?? '') || null;
            onDenied({ caller, method: methodDescriptor.path, correlationId });
            call.sendStatus({ code: grpc.status.PERMISSION_DENIED, details: 'caller not allowed', metadata: new grpc.Metadata() });
          },
        }),
    });
  };

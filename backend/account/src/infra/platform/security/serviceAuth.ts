import { timingSafeEqual } from 'node:crypto';
import grpc from '@grpc/grpc-js';

export const serviceNameHeader = 'x-service-name';
export const serviceTokenHeader = 'x-service-token';

export interface ServiceIdentity {
  readonly name: string;
  readonly token: string;
}

/** Who may call this server: service name -> token. Read from GRPC_ALLOWED_CALLERS ("wallet:token,order:token"). */
export type AllowedCallers = ReadonlyMap<string, string>;

/** Which callers may use each method, by gRPC method path. Owned by the server, in code. */
export type GrpcAllowlist = Readonly<Record<string, readonly string[]>>;

export interface DeniedCall {
  readonly caller: string | null;
  readonly method: string;
  readonly reason: 'unauthenticated' | 'notAllowed';
  readonly correlationId: string | null;
}

export class InvalidServiceAuthConfigurationError extends Error {
  constructor(reason: string) {
    super(`Invalid gRPC service auth configuration: ${reason}`);
    this.name = 'InvalidServiceAuthConfigurationError';
  }
}

const serviceName = /^[a-z][a-zA-Z0-9-]*$/;
const methodPath = /^\/[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/;

const parseCaller = (entry: string): [string, string] => {
  const [name = '', token = '', ...rest] = entry.split(':').map((part) => part.trim());
  if (!serviceName.test(name) || token.length === 0 || rest.length > 0) {
    throw new InvalidServiceAuthConfigurationError(`malformed caller entry "${entry}", expected name:token`);
  }
  return [name, token];
};

export const parseAllowedCallers = (value: string): AllowedCallers =>
  new Map(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map(parseCaller),
  );

export const validateAllowlist = (allowlist: GrpcAllowlist, servedMethods: readonly string[]): GrpcAllowlist => {
  const unknown = Object.keys(allowlist).filter((method) => !servedMethods.includes(method));
  if (unknown.length > 0) throw new InvalidServiceAuthConfigurationError(`unknown methods ${unknown.join(', ')}`);
  const malformed = Object.keys(allowlist).filter((method) => !methodPath.test(method));
  if (malformed.length > 0) throw new InvalidServiceAuthConfigurationError(`malformed methods ${malformed.join(', ')}`);
  return allowlist;
};

const sameToken = (expected: string, received: string): boolean => {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
};

const firstValue = (metadata: grpc.Metadata, key: string): string => String(metadata.get(key)[0] ?? '');

export const authenticatedCaller = (callers: AllowedCallers, metadata: grpc.Metadata): string | null => {
  const name = firstValue(metadata, serviceNameHeader);
  const expectedToken = callers.get(name);
  if (expectedToken === undefined) return null;
  return sameToken(expectedToken, firstValue(metadata, serviceTokenHeader)) ? name : null;
};

const isAllowed = (allowlist: GrpcAllowlist, method: string, caller: string): boolean =>
  (allowlist[method] ?? []).includes(caller);

const deny = (call: grpc.ServerInterceptingCallInterface, code: grpc.status, details: string): void =>
  call.sendStatus({ code, details, metadata: new grpc.Metadata() });

/** Runs before every handler: checks name + token, then the method allowlist. */
export const serviceAuthInterceptor =
  (callers: AllowedCallers, allowlist: GrpcAllowlist, onDenied: (deniedCall: DeniedCall) => void): grpc.ServerInterceptor =>
  (methodDescriptor, call) =>
    new grpc.ServerInterceptingCall(call, {
      start: (next) =>
        next({
          onReceiveMetadata: (metadata, metadataNext) => {
            const method = methodDescriptor.path;
            const correlationId = firstValue(metadata, 'x-correlation-id') || null;
            const caller = authenticatedCaller(callers, metadata);
            if (caller === null) {
              onDenied({ caller: firstValue(metadata, serviceNameHeader) || null, method, reason: 'unauthenticated', correlationId });
              return deny(call, grpc.status.UNAUTHENTICATED, 'unknown caller or wrong token');
            }
            if (!isAllowed(allowlist, method, caller)) {
              onDenied({ caller, method, reason: 'notAllowed', correlationId });
              return deny(call, grpc.status.PERMISSION_DENIED, 'caller not allowed for this method');
            }
            return metadataNext(metadata);
          },
        }),
    });

/** Client side: every outgoing call carries the caller's name and token. */
export const identify = (metadata: grpc.Metadata, identity: ServiceIdentity): grpc.Metadata => {
  metadata.set(serviceNameHeader, identity.name);
  metadata.set(serviceTokenHeader, identity.token);
  return metadata;
};

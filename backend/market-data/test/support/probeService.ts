import grpc from '@grpc/grpc-js';

export const probeMethod = '/trading.test.v1.Probe/Ping';

const json = {
  serialize: (value: unknown): Buffer => Buffer.from(JSON.stringify(value)),
  deserialize: (buffer: Buffer): unknown => JSON.parse(buffer.toString()),
};

export const probeServiceDefinition: grpc.ServiceDefinition = {
  ping: {
    path: probeMethod,
    requestStream: false,
    responseStream: false,
    requestSerialize: json.serialize,
    requestDeserialize: json.deserialize,
    responseSerialize: json.serialize,
    responseDeserialize: json.deserialize,
  },
};

type PingCallback = (error: grpc.ServiceError | null, response: unknown) => void;

interface ProbeClient extends grpc.Client {
  ping(request: unknown, metadata: grpc.Metadata, options: grpc.CallOptions, callback: PingCallback): void;
}

const ProbeClientConstructor = grpc.makeGenericClientConstructor(probeServiceDefinition, 'Probe');

export const createProbeClient = (
  address: string,
  credentials: grpc.ChannelCredentials,
  targetName: string,
): ProbeClient =>
  new ProbeClientConstructor(address, credentials, {
    'grpc.ssl_target_name_override': targetName,
  }) as unknown as ProbeClient;

export const callPing = (client: ProbeClient, metadata = new grpc.Metadata()): Promise<unknown> =>
  new Promise((resolve, reject) => {
    client.ping({}, metadata, { deadline: Date.now() + 2_000 }, (error, response) =>
      error ? reject(error) : resolve(response),
    );
  });

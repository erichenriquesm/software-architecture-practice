import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { v7 as uuidv7 } from 'uuid';

export interface Envelope<TPayload = Record<string, unknown>> {
  readonly eventId: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: TPayload;
}

export interface NewEnvelope<TPayload> {
  readonly type: string;
  readonly version: number;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly payload: TPayload;
}

export class InvalidEnvelopeError extends Error {
  constructor(readonly reasons: string) {
    super(`Invalid envelope: ${reasons}`);
    this.name = 'InvalidEnvelopeError';
  }
}

export const createEnvelope = <TPayload>(
  input: NewEnvelope<TPayload>,
  now: () => Date = () => new Date(),
  newId: () => string = uuidv7,
): Envelope<TPayload> => ({
  eventId: newId(),
  type: input.type,
  version: input.version,
  occurredAt: now().toISOString(),
  producer: input.producer,
  correlationId: input.correlationId,
  causationId: input.causationId ?? null,
  payload: input.payload,
});

export type EnvelopeValidator = (candidate: unknown) => Envelope;

export const loadEnvelopeValidator = (schemaFile = 'src/infra/contracts/envelope.schema.json'): EnvelopeValidator => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')));

  return (candidate) => {
    if (validate(candidate)) return candidate as Envelope;
    throw new InvalidEnvelopeError(ajv.errorsText(validate.errors));
  };
};

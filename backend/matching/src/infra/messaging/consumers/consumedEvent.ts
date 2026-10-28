import { InvalidBookDataError } from '../../../domain/errors.js';
import type { FailureKind } from '../../platform/messaging/consumer.js';
import type { Envelope } from '../../platform/messaging/envelope.js';
import { ContractViolationError, loadSchemaValidator } from '../../platform/messaging/schemas.js';
import type { SchemaValidator } from '../../platform/messaging/schemas.js';

/** Inbound ACL: checks the event type and version, then validates the payload against our copy of the contract. */
export const consumedEvent = <TPayload>(type: string): ((envelope: Envelope) => TPayload) => {
  const validate: SchemaValidator<TPayload> = loadSchemaValidator(`src/infra/contracts/consumed/events/${type}.v1.schema.json`);
  return (envelope) => {
    if (envelope.type !== type || envelope.version !== 1) {
      throw new ContractViolationError(type, `unexpected ${envelope.type} v${envelope.version}`);
    }
    return validate(envelope.payload);
  };
};

const permanentErrors = [ContractViolationError, InvalidBookDataError];

/** Bad payloads go to the DLQ at once; everything else (database, conflicts) is retried in process, holding the market. */
export const classifyMatchingFailure = (error: unknown): FailureKind =>
  permanentErrors.some((errorClass) => error instanceof errorClass) ? 'permanent' : 'transient';

import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export class ContractViolationError extends Error {
  constructor(
    readonly contract: string,
    readonly reasons: string,
  ) {
    super(`${contract}: ${reasons}`);
    this.name = 'ContractViolationError';
  }
}

export type SchemaValidator<T> = (candidate: unknown) => T;

export const loadSchemaValidator = <T>(schemaFile: string): SchemaValidator<T> => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats.default(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, 'utf8')));

  return (candidate) => {
    if (validate(candidate)) return candidate as T;
    throw new ContractViolationError(schemaFile, ajv.errorsText(validate.errors));
  };
};

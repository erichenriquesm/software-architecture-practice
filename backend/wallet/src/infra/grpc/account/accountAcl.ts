import { ContractViolationError } from '../../platform/messaging/schemas.js';

/** AccountService.Exists → our boolean. Anything else is outside the contract and is rejected. */
export const translateExists = (response: { readonly exists?: unknown }): boolean => {
  if (typeof response.exists !== 'boolean') throw new ContractViolationError('AccountService.Exists', `malformed ${JSON.stringify(response)}`);
  return response.exists;
};

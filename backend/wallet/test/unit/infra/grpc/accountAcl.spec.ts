import { describe, expect, test } from 'vitest';
import { translateExists } from '../../../../src/infra/grpc/account/accountAcl.js';
import { ContractViolationError } from '../../../../src/infra/platform/messaging/schemas.js';

describe('Account ACL', () => {
  test('Should translate AccountService.Exists to a boolean and refuse anything else', () => {
    // When & Then
    expect(translateExists({ exists: true })).toBe(true);
    expect(translateExists({ exists: false })).toBe(false);
    expect(() => translateExists({ exists: 'yes' })).toThrowError(ContractViolationError);
  });
});

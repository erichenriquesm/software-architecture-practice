import type { AssetBalance } from '../../../application/dtos/balanceView.js';
import { ContractViolationError } from '../../platform/messaging/schemas.js';

const decimal = /^\d+(\.\d{1,8})?$/;
const assetId = /^[A-Z]{3,5}$/;

interface WalletBalance {
  readonly assetId?: string;
  readonly available?: string;
  readonly reserved?: string;
}

const translateBalance = (balance: WalletBalance): AssetBalance => {
  const valid =
    assetId.test(balance.assetId ?? '') && decimal.test(balance.available ?? '') && decimal.test(balance.reserved ?? '');
  if (!valid) throw new ContractViolationError('WalletService.GetBalances', `malformed balance ${JSON.stringify(balance)}`);
  return { assetId: String(balance.assetId), available: String(balance.available), reserved: String(balance.reserved) };
};

export const translateWalletBalances = (response: { readonly balances?: readonly WalletBalance[] }): AssetBalance[] =>
  (response.balances ?? []).map(translateBalance);

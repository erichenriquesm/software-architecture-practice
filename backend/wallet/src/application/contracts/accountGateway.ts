/** "Does this account exist?" asked to the account service; used only when the wallet does not exist yet. */
export interface AccountGateway {
  exists(accountId: string): Promise<boolean>;
}

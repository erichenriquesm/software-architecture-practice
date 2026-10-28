export interface SignupInput {
  readonly name: string;
  readonly email: string;
  readonly document: string;
  readonly password: string;
}

export interface SignupOutput {
  readonly accountId: string;
}

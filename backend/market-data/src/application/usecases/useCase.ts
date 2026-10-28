/** A use case receives its parameters directly; only 3+ parameters are grouped in a <UseCase>Input DTO. */
export interface UseCase<TParameters extends readonly unknown[], TOutput> {
  execute(...parameters: TParameters): Promise<TOutput>;
}

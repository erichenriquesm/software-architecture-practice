export abstract class FallbackHandler<TInput, TOutput> {
  constructor(private readonly next?: FallbackHandler<TInput, TOutput>) {}

  protected abstract tryHandle(input: TInput): Promise<TOutput>;

  async handle(input: TInput): Promise<TOutput> {
    try {
      return await this.tryHandle(input);
    } catch (error) {
      if (!this.next) throw error;
      return this.next.handle(input);
    }
  }
}

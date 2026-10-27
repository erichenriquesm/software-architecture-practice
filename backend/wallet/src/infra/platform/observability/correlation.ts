import { AsyncLocalStorage } from 'node:async_hooks';
import { v7 as uuidv7 } from 'uuid';

export interface Correlation {
  readonly correlationId: string;
  readonly causationId: string | null;
}

const storage = new AsyncLocalStorage<Correlation>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const correlationFrom = (incoming: string | undefined, causationId: string | null = null): Correlation => ({
  correlationId: incoming && uuid.test(incoming) ? incoming : uuidv7(),
  causationId,
});

export const withCorrelation = <T>(correlation: Correlation, work: () => Promise<T>): Promise<T> =>
  storage.run(correlation, work);

export const currentCorrelation = (): Correlation => storage.getStore() ?? correlationFrom(undefined);

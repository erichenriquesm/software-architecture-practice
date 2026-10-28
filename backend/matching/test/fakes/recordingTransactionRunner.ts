import type { TransactionRunner } from '../../src/application/contracts/transactionRunner.js';

export class RecordingTransactionRunner implements TransactionRunner {
  runs = 0;

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.runs += 1;
    return work();
  }
}

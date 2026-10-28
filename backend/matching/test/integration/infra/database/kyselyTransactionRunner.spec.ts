import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { TestDatabase } from '../../../support/database.js';
import { createTestDatabase } from '../../../support/database.js';
import type { Database } from '../../../../src/infra/database/database.js';
import { InProcessDomainEventDispatcher } from '../../../../src/infra/platform/events/inProcessDomainEventDispatcher.js';
import { KyselyTransactionRunner } from '../../../../src/infra/database/kyselyTransactionRunner.js';

let database: TestDatabase;
let runner: KyselyTransactionRunner<Database>;
let dispatcher: InProcessDomainEventDispatcher;

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new KyselyTransactionRunner(database.db);
  dispatcher = new InProcessDomainEventDispatcher().on('thing.happened', async () => {
    await runner.transaction().insertInto('inbox').values({ consumer: 'handler', message_key: 'from-handler' }).execute();
  });
});

afterAll(() => database.destroy());

const writeAndDispatch = (key: string, fail: boolean) =>
  runner.run(async () => {
    await runner.executor().insertInto('inbox').values({ consumer: 'repository', message_key: key }).execute();
    await dispatcher.dispatch([{ type: 'thing.happened', occurredAt: new Date() }]);
    if (fail) throw new Error('use case failed after dispatch');
  });

const keys = async () =>
  (await database.db.selectFrom('inbox').select('message_key').orderBy('message_key').execute()).map((row) => row.message_key);

describe('KyselyTransactionRunner with the in-process dispatcher', () => {
  test('Should roll back the repository write and the handler write together when the use case fails', async () => {
    // When
    await expect(writeAndDispatch('failed', true)).rejects.toThrowError('use case failed after dispatch');

    // Then
    expect(await keys()).toEqual([]);
  });

  test('Should commit both writes in one transaction when the use case succeeds', async () => {
    // When
    await writeAndDispatch('committed', false);

    // Then
    expect(await keys()).toEqual(['committed', 'from-handler']);
  });
});

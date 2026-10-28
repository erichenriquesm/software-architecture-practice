import { buildMarketDataCore } from './composition.js';
import { createDatabase } from './database/postgres.js';
import { classifyMarketDataFailure } from './messaging/consumers/consumedEvent.js';
import { declareMatchingLog, matchingLog, matchingLogHandler } from './messaging/matchingLog.js';
import { MatchingLogReplayer } from './messaging/matchingLogReplayer.js';
import { connectRabbitMq, rabbitMqUrlFromEnv } from './platform/messaging/connection.js';
import { loadEnvelopeValidator } from './platform/messaging/envelope.js';
import { durationSetting, postgresSettings } from './settings.js';

/*
 * npm run projections:rebuild (make projections-rebuild, inside the worker container): empties every *_view table
 * and replays them from the first offset of the marketData.matchingLog stream.
 */
const db = createDatabase(postgresSettings());
const connection = await connectRabbitMq(rabbitMqUrlFromEnv());
try {
  const channel = await connection.createChannel();
  await declareMatchingLog(channel);
  const replayer = new MatchingLogReplayer(db, channel, {
    stream: matchingLog.stream,
    handler: matchingLogHandler(buildMarketDataCore({ db }).bookProjector),
    validate: loadEnvelopeValidator(),
    classify: classifyMarketDataFailure,
    idleTimeoutMs: durationSetting('REBUILD_IDLE_TIMEOUT', '2s'),
  });
  const result = await replayer.rebuild();
  console.log(`projections rebuilt: ${result.applied} events applied, ${result.skipped} skipped`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await connection.close();
  await db.destroy();
}

import { readFileSync } from 'node:fs';
import { loadSchemaValidator } from '../platform/messaging/schemas.js';

interface CatalogFile {
  readonly markets: readonly { readonly marketId: string; readonly status: string }[];
}

/** The markets that get a queue and a consumer: the active ones of markets.json, validated at startup. */
export const activeMarkets = (file = 'src/infra/contracts/markets.json', schemaFile = 'src/infra/contracts/markets.schema.json'): string[] =>
  loadSchemaValidator<CatalogFile>(schemaFile)(JSON.parse(readFileSync(file, 'utf8')))
    .markets.filter((market) => market.status === 'active')
    .map((market) => market.marketId);

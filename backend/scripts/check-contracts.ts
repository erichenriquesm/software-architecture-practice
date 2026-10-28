import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const backend = process.argv[2] ?? '.';
const ownerless = join(backend, 'infra', 'contracts');
const skipped = new Set(['infra', 'scripts', 'node_modules', 'e2e']);

const filesUnder = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
};

const services = readdirSync(backend).filter(
  (entry) => !skipped.has(entry) && existsSync(join(backend, entry, 'src', 'infra', 'contracts')),
);

const originals = new Map<string, string>();
const problems: string[] = [];

for (const service of services) {
  const published = join(backend, service, 'src', 'infra', 'contracts', 'published');
  for (const file of filesUnder(published)) {
    const contract = relative(published, file);
    const owner = originals.get(contract);
    if (owner) problems.push(`${contract} is published by two services: ${relative(backend, owner)} and ${relative(backend, file)}`);
    originals.set(contract, file);
  }
}
for (const file of filesUnder(ownerless)) originals.set(`ownerless/${relative(ownerless, file)}`, file);

const originalFor = (service: string, file: string): string | undefined => {
  const contracts = join(backend, service, 'src', 'infra', 'contracts');
  const consumed = join(contracts, 'consumed');
  if (file.startsWith(consumed)) return originals.get(relative(consumed, file));
  if (file.startsWith(join(contracts, 'published'))) return file;
  return originals.get(`ownerless/${relative(contracts, file)}`);
};

// Services are built one at a time: a copy whose owner does not exist yet is reported, not failed.
const ownerFolderOf = (file: string): string | undefined => {
  const prefix = file.split('/').pop()?.split('.')[0];
  return prefix === 'marketData' ? 'market-data' : prefix;
};

const pending: string[] = [];
let copies = 0;
for (const service of services) {
  for (const file of filesUnder(join(backend, service, 'src', 'infra', 'contracts'))) {
    const original = originalFor(service, file);
    if (original === file) continue;
    copies += 1;
    if (!original) {
      const owner = ownerFolderOf(file);
      if (owner && !existsSync(join(backend, owner))) {
        pending.push(`${relative(backend, file)} (owner ${owner} not built yet)`);
        continue;
      }
      problems.push(`${relative(backend, file)} has no original (no owner publishes it)`);
      continue;
    }
    if (!readFileSync(original).equals(readFileSync(file))) {
      problems.push(`${relative(backend, file)} differs from its original ${relative(backend, original)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `contract: ${problem}`).join('\n'));
  process.exit(1);
}
for (const copy of pending) console.log(`contract pending: ${copy}`);
console.log(`contracts ok (${services.length} services, ${originals.size} originals, ${copies} copies)`);

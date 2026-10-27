import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const kebabCase = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const template = 'service-template';
const ignored = new Set(['node_modules', 'dist', 'coverage', 'generated']);

const name = process.argv[2] ?? '';
const backend = process.argv[3] ?? '.';

if (!kebabCase.test(name) || name === template) {
  console.error('usage: node scripts/scaffold.ts <kebab-case-service-name> [backendDir]');
  process.exit(2);
}

const words = name.split('-');
const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const replacements: ReadonlyArray<readonly [string, string]> = [
  ['service-template', name],
  ['service_template', words.join('_')],
  ['ServiceTemplate', words.map(capitalize).join('')],
  ['serviceTemplate', words[0] + words.slice(1).map(capitalize).join('')],
];
const rename = (text: string): string => replacements.reduce((current, [from, to]) => current.replaceAll(from, to), text);

const source = join(backend, template);
const target = join(backend, name);
if (existsSync(target)) {
  console.error(`scaffold: ${target} already exists`);
  process.exit(1);
}

cpSync(source, target, { recursive: true, filter: (path) => !ignored.has(basename(path)) });

const visit = (path: string): void => {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) visit(join(path, entry));
  } else {
    const content = readFileSync(path, 'utf8');
    const renamed = rename(content);
    if (renamed !== content) writeFileSync(path, renamed);
  }
  const renamedPath = join(dirname(path), rename(basename(path)));
  if (renamedPath !== path) renameSync(path, renamedPath);
};
visit(target);

console.log(`scaffold: created ${target} from ${template}`);
console.log('next: add the service to infra/security/init.sh IDS, include it in backend/docker-compose.yml, and regenerate its lockfile');

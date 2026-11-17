/**
 * Bump a release version everywhere it is written.
 *
 * A release touches `package.json`, `client.js` (VERSION constant, when the
 * plugin has one), and the market `index.json` (version + git commit). Doing
 * these by hand is how 0.4.13 ended up tagged before its index was bumped.
 * This script only edits files; packing, tagging and pushing stay manual.
 *
 * Usage: node scripts/prepare-release.mjs 0.9.60
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const target = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  console.error('usage: node scripts/prepare-release.mjs <major.minor.patch>');
  process.exit(1);
}

function compare(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = String(pkg.version || '').trim();
if (compare(target, current) < 0) {
  console.error('refusing to downgrade: current ' + current + ', target ' + target);
  process.exit(1);
}

const changed = [];
if (compare(target, current) > 0) {
  pkg.version = target;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  changed.push('package.json ' + current + ' -> ' + target);
} else {
  changed.push('package.json already ' + target);
}

/* Plugins that report their version from the client bundle keep a constant. */
const clientPath = path.join(root, 'client.js');
if (existsSync(clientPath)) {
  const source = readFileSync(clientPath, 'utf8');
  const pattern = /const VERSION = '([^']+)'/;
  const match = source.match(pattern);
  if (match) {
    if (match[1] !== target) {
      writeFileSync(clientPath, source.replace(pattern, "const VERSION = '" + target + "'"), 'utf8');
      changed.push('client.js VERSION ' + match[1] + ' -> ' + target);
    } else {
      changed.push('client.js VERSION already ' + target);
    }
  }
}

/* The market index only exists in the release checkout. */
const indexPath = path.join(root, 'index.json');
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const name = pkg.name;
  const row = (index.plugins || []).find((plugin) => plugin.name === name);
  if (!row) {
    console.error('index.json has no plugin row named ' + name);
    process.exit(1);
  }
  row.versions = [{
    version: target,
    publishTimestamp: Math.floor(Date.now() / 1000),
    source: { type: 'git', url: 'https://github.com/Kattentions/' + name + '.git', commit: 'PENDING' },
  }];
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  changed.push('index.json -> ' + target + ' (commit PENDING)');
}

console.log('prepared ' + target + ':');
for (const line of changed) console.log('  - ' + line);
console.log('\nnext: update CHANGELOG.md, run `npm run check:release`, pack, commit the release,');
console.log('      then set index.json source.commit to that commit in a follow-up `market:` commit,');
console.log('      tag the follow-up commit (never amend afterwards) and push.');

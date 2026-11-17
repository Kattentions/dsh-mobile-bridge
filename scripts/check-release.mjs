/**
 * Release consistency check.
 *
 * The version a release declares lives in two places: `package.json` and the
 * market `index.json`. The bridge client takes its version from the Host route
 * rather than a constant, so only these two must agree.
 *
 * Usage: node scripts/check-release.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const problems = [];

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (version === '') problems.push('package.json has no version');

const indexPath = path.join(root, 'index.json');
if (!existsSync(indexPath)) {
  problems.push('index.json is missing');
} else {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const row = (index.plugins || []).find((plugin) => plugin.name === 'dsh-mobile-bridge');
  const listed = row && row.versions && row.versions.length > 0 ? String(row.versions[0].version || '') : '';
  if (listed !== version) problems.push('index.json lists ' + (listed || 'nothing') + ', package.json is ' + version);
}

for (const required of [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
  'public/app/dsh-harness.apk',
  'public/app/version.json',
  'vendor/qr.mjs',
  'scripts/check-endpoints.mjs',
  'scripts/check-app.mjs',
]) {
  if (!existsSync(path.join(root, required))) problems.push('missing required file: ' + required);
}

if (problems.length > 0) {
  console.error('release metadata is inconsistent:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log('release metadata OK: v' + version + ' (package and index agree)');

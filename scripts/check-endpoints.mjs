/**
 * Phone-shell / bridge endpoint contract check.
 *
 * The APK in `_android` and this bridge evolve separately: the app hardcodes
 * `/__ink/...` paths and the bridge registers them. When one side renames a
 * route the failure only shows up as a dead feature on a real phone, so this
 * script compares both sides statically.
 *
 * Usage: node scripts/check-endpoints.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bridgeSource = readFileSync(path.join(root, 'index.js'), 'utf8');
/* Android sources live next to the plugin in the workspace: now try the known
   layouts instead of assuming one, so an installed package can skip cleanly. */
const appCandidates = [
  path.resolve(root, '..', '..', '_android', 'apk', 'src', 'ink', 'dsh', 'harness'),
  path.resolve(root, '..', '_android', 'apk', 'src', 'ink', 'dsh', 'harness'),
  path.resolve(root, '_android', 'apk', 'src', 'ink', 'dsh', 'harness'),
];
const appDir = appCandidates.find((candidate) => existsSync(candidate)) || appCandidates[0];

/** Route paths registered by the bridge plugin. */
function registeredRoutes(source) {
  const routes = new Set();
  for (const match of source.matchAll(/path:\s*'(\/__ink\/[^']*)'/g)) routes.add(match[1]);
  return routes;
}

/** `/__ink/...` paths referenced by the Android shell sources. */
function appReferences(dir) {
  if (!existsSync(dir)) return null;
  const references = new Set();
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.java')) continue;
    const text = readFileSync(path.join(dir, entry), 'utf8');
    for (const match of text.matchAll(/["'](\/__ink\/[A-Za-z0-9_\/.-]*)["']/g)) references.add(match[1]);
  }
  return references;
}

const routes = registeredRoutes(bridgeSource);
const references = appReferences(appDir);

console.log('bridge registers ' + routes.size + ' routes:');
for (const route of [...routes].sort()) console.log('  ' + route);

if (references === null) {
  console.log('\nAndroid sources not found (' + appCandidates.length + ' locations checked) — skipped app-side comparison.');
  process.exit(0);
}

console.log('\napp references ' + references.size + ' paths:');
for (const reference of [...references].sort()) console.log('  ' + reference);
const missing = [...references]
  .filter((reference) => {
    if (routes.has(reference)) return false;
    /* Dynamic suffixes like `/__ink/pair/qr` registered as one exact path are
       expected to match; only flag paths no registered route can serve. */
    return ![...routes].some((route) => route.startsWith(reference) || reference.startsWith(route));
  })
  .sort();

if (missing.length === 0) {
  console.log('All app-referenced /__ink paths have a registered route.');
  process.exit(0);
}

console.error('\nApp references routes the bridge does not register:');
for (const item of missing) console.error('  - ' + item);
process.exit(1);

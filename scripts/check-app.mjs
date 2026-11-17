/**
 * Phone shell artifact check.
 *
 * `public/app` ships the APK plus the version manifest the phone's "check for
 * updates" reads. If the two drift (a rebuild forgets the manifest, or a stale
 * APK stays behind) the phone either sees no update or downloads a file whose
 * size does not match, and nothing fails until someone notices on the device.
 *
 * Usage: node scripts/check-app.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const appDir = path.join(root, 'public', 'app');
const apkPath = path.join(appDir, 'dsh-harness.apk');
const versionPath = path.join(appDir, 'version.json');

if (!existsSync(apkPath)) {
  console.error('missing APK: ' + apkPath);
  process.exit(1);
}
if (!existsSync(versionPath)) {
  console.error('missing version.json: ' + versionPath + ' (rebuild with _android/build.ps1)');
  process.exit(1);
}

let version = null;
try {
  version = JSON.parse(readFileSync(versionPath, 'utf8'));
} catch (error) {
  console.error('version.json is not valid JSON: ' + String(error && error.message ? error.message : error));
  process.exit(1);
}

const apkSize = statSync(apkPath).size;
const problems = [];
if (!version || typeof version.version !== 'string' || version.version.trim() === '') problems.push('version field is empty');
if (version && (version.versionCode === undefined || String(version.versionCode).trim() === '')) problems.push('versionCode field is empty');
if (version && Number(version.size) !== apkSize) {
  problems.push('size mismatch: manifest says ' + Number(version.size) + ' bytes, APK is ' + apkSize + ' bytes');
}
if (!version || typeof version.builtAt !== 'string' || version.builtAt.trim() === '') problems.push('builtAt field is empty');

if (problems.length > 0) {
  console.error('app artifacts are inconsistent:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

console.log('app artifacts OK: v' + version.version + ' (' + version.versionCode + '), ' + apkSize + ' bytes, built ' + version.builtAt);

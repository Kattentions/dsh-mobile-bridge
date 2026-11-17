/**
 * Live device-isolation probe.
 *
 * Pairs two throwaway devices over the running bridge, then proves that
 * revoking one leaves the other working (and that the revoked token is
 * rejected immediately). Devices it creates are revoked again at the end, so a
 * real phone paired on this machine is never touched.
 *
 * Requires the desktop host and bridge to be running.
 *
 * Usage: node scripts/probe-devices.mjs [host] [bridge]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const host = String(process.argv[2] || 'http://127.0.0.1:7357').replace(/\/+$/, '');
const bridge = String(process.argv[3] || 'http://127.0.0.1:6080').replace(/\/+$/, '');
const keyFile = path.join(homedir(), '.dsh', 'mobile-bridge.key');
let key = '';
try {
  key = readFileSync(keyFile, 'utf8').trim();
} catch (error) {
  console.error('cannot read ' + keyFile + ': ' + String(error && error.message ? error.message : error));
  process.exit(1);
}

const problems = [];
const created = [];
const check = (ok, label, detail = '') => {
  if (ok) { console.log('ok   ' + label + (detail ? ' — ' + detail : '')); return; }
  problems.push(label + (detail ? ': ' + detail : ''));
  console.error('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

async function devices() {
  const response = await fetch(host + '/__ink/pair/devices');
  if (!response.ok) throw new Error('devices route returned ' + response.status);
  return (await response.json()).devices || [];
}

async function mintCode() {
  const response = await fetch(host + '/__ink/pair/code?k=' + encodeURIComponent(key));
  if (!response.ok) throw new Error('pair code route returned ' + response.status);
  return (await response.json()).code;
}

async function redeem(code) {
  const response = await fetch(bridge + '/pair?c=' + encodeURIComponent(code), { redirect: 'manual' });
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')];
  const token = cookies.map((value) => String(value)).find((value) => value.startsWith('dsh-bridge-token='));
  if (!token) throw new Error('pair redeem did not set a device cookie (status ' + response.status + ')');
  return token.split(';')[0];
}

async function pull(cookie) {
  const response = await fetch(bridge + '/__ink/phone/pull', { headers: { cookie } });
  return response.status;
}

async function revoke(id) {
  const response = await fetch(host + '/__ink/pair/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return response.status;
}

/** Pair once and return the exact device id the host just created. */
async function pairOne() {
  const before = new Set((await devices()).map((row) => row.id));
  const cookie = await redeem(await mintCode());
  const after = await devices();
  const fresh = after.find((row) => !before.has(row.id));
  if (!fresh) throw new Error('paired device did not appear in the device list');
  created.push(fresh.id);
  return { cookie, id: fresh.id };
}

try {
  const deviceA = await pairOne();
  const deviceB = await pairOne();
  check(created.length === 2, 'two devices paired', created.length + ' new');
  check(deviceA.id !== deviceB.id, 'paired devices have distinct ids');

  check((await pull(deviceA.cookie)) === 200, 'device A can pull');
  check((await pull(deviceB.cookie)) === 200, 'device B can pull');

  check((await revoke(deviceA.id)) === 200, 'revoke device A');
  check((await pull(deviceA.cookie)) === 401, 'revoked device A is rejected');
  check((await pull(deviceB.cookie)) === 200, 'device B survives A being revoked');

  const remaining = await devices();
  check(remaining.some((row) => row.id === deviceB.id), 'device B still listed');
  check(!remaining.some((row) => row.id === deviceA.id), 'revoked device A is gone');
} catch (error) {
  problems.push(String(error && error.message ? error.message : error));
} finally {
  for (const id of created) {
    await revoke(id).catch(() => {});
  }
  await fetch(bridge + '/__ink/phone/clear', { method: 'POST', headers: { cookie: 'dsh-bridge=' + key } }).catch(() => {});
}

if (problems.length > 0) {
  console.error('\ndevice isolation probe failed:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exitCode = 1;
} else {
  console.log('\ndevice isolation OK (temporary devices revoked, phone queue cleared)');
}

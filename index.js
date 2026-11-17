/**
 * Host half of the DSH mobile bridge.
 *
 * The desktop host listens on loopback with a random port and a launch token, so the
 * GUI is unreachable from another device. This plugin opens a second listener on the
 * LAN (Sunlogin/Oray virtual LAN, Wi-Fi, Tailscale), keeps the upstream cookie
 * server-side and rewrites the request authority to loopback, so a phone sees an
 * ordinary site. A one-time key query mints the bridge cookie; after that the phone
 * needs no token.
 *
 * It also serves the pairing page with QR codes, a mobile directory picker, the APK
 * download page, and a turn-end notification stream the phone (or its shell) polls.
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, createReadStream, renameSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcodeFactory from './vendor/qr.mjs';

/** Ports tried in order; the first free one wins. */
const BRIDGE_PORTS = [6080, 6081, 6090, 7090];
/** Set once the listener is up so pairState can tell "running" from "stale file". */
let bridgePort = 0;
const BRIDGE_STATE_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'mobile-bridge.json');
const BRIDGE_COOKIE = 'dsh-bridge';
/** Per-device credential cookie issued by redeeming a one-time pairing code. */
const DEVICE_COOKIE = 'dsh-bridge-token';
const DEVICE_STORE_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'mobile-bridge-devices.json');
const BRIDGE_KEY_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'mobile-bridge.key');
/**
 * Append to a diagnostic log, rotating it once it passes the cap. The phone polls
 * and reconnects this stream often; unbounded growth would quietly fill the disk.
 * @param {string} file - log path.
 * @param {string} text - line(s) to append.
 * @param {number} [maxBytes] - rotate threshold, default 128 KiB.
 */
function appendBounded(file, text, maxBytes = 128 * 1024) {
  try {
    if (existsSync(file) && statSync(file).size + text.length > maxBytes) {
      try { renameSync(file, file + '.old'); } catch (error) { writeFileSync(file, '', 'utf8'); }
    }
    writeFileSync(file, text, { flag: 'a' });
  } catch (error) { /* diagnostics only */ }
}

const HELLO_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'notify-hello.log');
const DUMP_FILE = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'ui-dump.txt');
/* The phone APK lives next to the plugin: `_android/build.ps1` copies it here and
   writes version.json, so a paired phone can update over the same bridge. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(PLUGIN_DIR, 'public', 'app');
const APP_APK = 'dsh-harness.apk';

/**
 * Reuse the previous key so a bookmarked phone URL keeps working across app
 * restarts. It lives in its own file because the status file is rewritten on
 * every start/stop and must not be able to erase the key.
 * @returns {string} bridge key.
 */
function loadBridgeKey() {
  try {
    const stored = readFileSync(BRIDGE_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-f]{12,}$/.test(stored)) return stored;
  } catch (error) { /* first run */ }
  return randomBytes(9).toString('hex');
}

const BRIDGE_KEY = loadBridgeKey();

/** Paired-device registry: only SHA-256 digests of device tokens are stored. */
function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function loadDevices() {
  try {
    const parsed = JSON.parse(readFileSync(DEVICE_STORE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.devices)) return [];
    return parsed.devices.filter((row) => row && typeof row.id === 'string' && typeof row.tokenHash === 'string');
  } catch (error) { return []; }
}

let BRIDGE_PAIRED = loadDevices();

function saveDevices() {
  try { writeFileSync(DEVICE_STORE_FILE, JSON.stringify({ version: 1, devices: BRIDGE_PAIRED }, null, 2), 'utf8'); } catch (error) { /* best effort */ }
}

/** One-time pairing codes: memory only, so a restart invalidates every outstanding QR. */
const PAIR_CODES = new Map();
const PAIR_CODE_TTL_MS = 120_000;

function mintPairCode() {
  const now = Date.now();
  for (const [code, row] of PAIR_CODES) if (row.expiresAt <= now) PAIR_CODES.delete(code);
  let code = '';
  do { code = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (PAIR_CODES.has(code));
  PAIR_CODES.set(code, { expiresAt: now + PAIR_CODE_TTL_MS });
  return { code, expiresAt: now + PAIR_CODE_TTL_MS };
}

/** Redeem a pairing code once; returns the fresh device token or an error code. */
function redeemPairCode(code) {
  const row = PAIR_CODES.get(String(code || ''));
  if (row === undefined) return { error: 'invalid-code' };
  PAIR_CODES.delete(String(code));
  if (row.expiresAt <= Date.now()) return { error: 'expired-code' };
  const token = randomBytes(32).toString('hex');
  const device = {
    id: randomBytes(8).toString('hex'),
    name: '手机',
    tokenHash: sha256(token),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  BRIDGE_PAIRED = [device, ...BRIDGE_PAIRED].slice(0, 50);
  saveDevices();
  return { token, device };
}

/** Find a paired device by its cookie token without leaking the token itself. */
function deviceForToken(token) {
  const digest = sha256(String(token || ''));
  const device = BRIDGE_PAIRED.find((row) => row.tokenHash === digest);
  if (device === undefined) return undefined;
  device.lastSeenAt = Date.now();
  return device;
}

function revokeDevice(id) {
  const before = BRIDGE_PAIRED.length;
  BRIDGE_PAIRED = BRIDGE_PAIRED.filter((row) => row.id !== String(id));
  if (BRIDGE_PAIRED.length !== before) saveDevices();
  return BRIDGE_PAIRED.length !== before;
}

/** Devices seen through the bridge, keyed by address + user agent. Memory only. */
const BRIDGE_DEVICES = new Map();
const DEVICE_LIMIT = 10;

/**
 * Remember who is connected for the "设备互联" settings page. Best effort: a
 * failure here must never break the proxy.
 * @param {object} request - incoming request.
 */
function recordDevice(request) {
  try {
    const ip = String((request.socket && request.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    if (ip === '') return;
    const ua = String(request.headers['user-agent'] || '').slice(0, 180);
    const key = ip + '|' + ua;
    const now = Date.now();
    const entry = BRIDGE_DEVICES.get(key);
    if (entry !== undefined) {
      entry.lastAt = now;
      entry.count += 1;
    } else {
      BRIDGE_DEVICES.set(key, { ip, ua, firstAt: now, lastAt: now, count: 1 });
    }
    if (BRIDGE_DEVICES.size > DEVICE_LIMIT * 2) {
      const ordered = [...BRIDGE_DEVICES.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
      for (const [stale] of ordered.slice(0, ordered.length - DEVICE_LIMIT)) BRIDGE_DEVICES.delete(stale);
    }
  } catch (error) { /* tracking only */ }
}

/** Constant-time check for the bridge key (both cookie value and ?k=). */
function keyEquals(candidate) {
  const left = Buffer.from(String(candidate || ''), 'utf8');
  const right = Buffer.from(BRIDGE_KEY, 'utf8');
  if (left.length !== right.length) return false;
  try { return timingSafeEqual(left, right); } catch (error) { return false; }
}

/* Failed key attempts, keyed by client address. A LAN listener is small enough
   that brute-forcing a 9-byte key is infeasible, but a noise source should not
   keep the CPU busy either. */
const AUTH_FAILURES = new Map();
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 12;

function clientAddress(request) {
  return String((request.socket && request.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

/** @returns {number} milliseconds the client must wait, or 0 when allowed. */
function authBlockedFor(request) {
  const ip = clientAddress(request);
  const entry = AUTH_FAILURES.get(ip);
  if (entry === undefined) return 0;
  const now = Date.now();
  if (entry.until > now) return entry.until - now;
  /* Keep the counter while its window is still open: deleting it here restarted
     the count on every request, so the limit never fired. */
  if (now - entry.since > AUTH_WINDOW_MS) AUTH_FAILURES.delete(ip);
  return 0;
}

function recordAuthFailure(request) {
  const ip = clientAddress(request);
  const now = Date.now();
  const entry = AUTH_FAILURES.get(ip) || { count: 0, since: now, until: 0 };
  if (now - entry.since > AUTH_WINDOW_MS) { entry.count = 0; entry.since = now; }
  entry.count += 1;
  if (entry.count >= AUTH_MAX_FAILURES) entry.until = now + AUTH_WINDOW_MS;
  AUTH_FAILURES.set(ip, entry);
  if (AUTH_FAILURES.size > 128) {
    for (const [key, value] of AUTH_FAILURES) if (value.until < now) AUTH_FAILURES.delete(key);
  }
}

function clearAuthFailures(request) {
  AUTH_FAILURES.delete(clientAddress(request));
}

/** WebSocket paths the GUI actually opens; everything else is refused. */
const WS_ALLOW_PREFIXES = ['/api/', '/sidebar/', '/__', '/favicon', '/assets/', '/manifest.webmanifest'];
const WS_STATS = new Map();
const WS_DENIED = new Map();

/** Queued phone commands (agent -> app). Memory only: a restart drops them. */
const PHONE_QUEUE = [];
const PHONE_RESULTS = [];
let PHONE_SEQ = 0;
/* Commands are broadcast, not consumed: each paired device keeps a cursor, so two
   phones polling at once both receive a notification instead of racing for it. */
const PHONE_CURSORS = new Map();

/** Cookie reader usable outside the proxy scope (device auth helpers live here). */
function phoneCookie(request, name) {
  const header = request && request.headers ? request.headers.cookie : '';
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

/** Identity used for cursors: the paired device id, else the raw cookie, else shared. */
function phoneDeviceKey(request) {
  /* The proxy replaces the client's cookie with the upstream GUI session before
     forwarding, so the device token is gone by the time a route handler runs. The
     proxy stamps the resolved device id on a private header instead. */
  const stamped = request && request.headers ? String(request.headers['x-dsh-bridge-device'] || '') : '';
  if (stamped !== '') return 'device:' + stamped;
  const token = phoneCookie(request, DEVICE_COOKIE);
  const device = token === '' ? undefined : deviceForToken(token);
  if (device && device.id) return 'device:' + device.id;
  return token === '' ? 'shared' : 'token:' + token.slice(0, 12);
}

/** Commands this device has not received yet; advances only its own cursor. */
function takePhoneCommands(deviceKey) {
  const last = PHONE_CURSORS.get(deviceKey) || 0;
  const pending = PHONE_QUEUE.filter((command) => Number(command.seq || 0) > last).slice(0, 10);
  if (pending.length > 0) {
    PHONE_CURSORS.set(deviceKey, Number(pending[pending.length - 1].seq) || last);
    if (PHONE_CURSORS.size > 64) {
      const oldest = PHONE_CURSORS.keys().next().value;
      if (oldest !== undefined) PHONE_CURSORS.delete(oldest);
    }
  }
  return pending;
}

function enqueuePhoneCommand(type, title, text) {
  PHONE_SEQ += 1;
  const command = {
    seq: PHONE_SEQ,
    id: 'p' + PHONE_SEQ.toString(36) + randomBytes(3).toString('hex'),
    type: String(type || 'notify'),
    title: String(title || 'DSH'),
    text: String(text || ''),
    createdAt: Date.now(),
  };
  PHONE_QUEUE.push(command);
  if (PHONE_QUEUE.length > 50) PHONE_QUEUE.shift();
  return command;
}

function bumpCounter(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
  if (map.size > 64) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** The index tap only exists when the page is served over HTTP. */
export const inject = ['webServer', 'tools'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {


  /* Agent -> phone. The app polls these when it is alive; a command that is never
     delivered simply expires with the process, so nothing pretends to succeed. */
  ctx.inject(['tools'], (toolsInner) => {
    const textRender = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
    const output = { schema: { type: 'object' }, render: (_args, value) => textRender(value) };
    const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
    toolsInner.tools.register({
      name: 'phone_notify',
      description: '给已配对的手机发一条系统通知。手机上要装 DSH 手机壳并且 App 在后台保持连接；只排队、不保证送达。',
      parameters: schema({
        title: { type: 'string', description: '通知标题，例如「DSH 任务完成」' },
        text: { type: 'string', description: '通知正文，一两句话' },
      }, ['title']),
      output,
      execute: async (args) => {
        const command = enqueuePhoneCommand('notify', args && args.title, args && args.text);
        return { ok: true, queued: true, id: command.id, pending: PHONE_QUEUE.length };
      },
    });
    toolsInner.tools.register({
      name: 'phone_state',
      description: '看手机命令队列的状态：还没被取走的命令数，以及最近一次手机回执。',
      parameters: schema({}),
      output,
      execute: async () => ({
        pending: PHONE_QUEUE.length,
        cursors: PHONE_CURSORS.size,
        commands: PHONE_QUEUE.slice(-5),
        results: PHONE_RESULTS.slice(-5),
      }),
    });
  });
  ctx.inject(['webServer'], (inner) => {
    /* Liveness probe used while wiring the pairing page: answers without
       touching the UI, so a stale host build is obvious from curl. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/ping',
      handler: (request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('pong');
      }
    }));

    /* Directory listing for the phone. The shell's "add workspace" control calls
       /api/directoryPicker/pick, which opens a native dialog that a WebView can
       never show, so the button is dead on a phone. This route lets the client
       half render its own picker from the desktop's real file system. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/fs',
      handler: (request, response) => {
        const query = new URL(request.url || '/', 'http://host.invalid');
        const answer = listDirectories(query.searchParams.get('path') || '');
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(answer));
      }
    }));

    /* Pairing screen. Opens on the desktop origin (127.0.0.1:<port>) and shows
       the bridge URLs as QR codes, so a phone pairs by scanning instead of
       typing an address and a key. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair',
      handler: (request, response) => {
        let state = null;
        try { state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8')); } catch (error) { /* bridge not up */ }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(renderPairPage(state));
      }
    }));

    /* Same data, split for the in-app settings section: JSON it can lay out,
       and SVG it can drop into an <img>. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair/state',
      handler: (request, response) => {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*'
        });
        response.end(JSON.stringify(pairState()));
      }
    }));
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair/qr',
      handler: (request, response) => {
        let data = '';
        try {
          const url = new URL(request.url || '/', 'http://pair.invalid');
          data = url.searchParams.get('d') || '';
        } catch (error) { /* malformed query */ }
        if (data === '') {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('missing d');
          return;
        }
        response.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=86400'
        });
        response.end(qrSvgOf(data));
      }
    }));
    /* Per-device pairing: the desktop asks for a short-lived code, shows it as a
       QR, and the phone redeems it once for its own token. The long-lived master
       key stays available for existing links but is no longer the only way in. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair/code',
      handler: (request, response) => {
        const minted = mintPairCode();
        let state = null;
        try { state = pairState(); } catch (error) { /* bridge down */ }
        const networks = state && Array.isArray(state.networks) ? state.networks.map((entry, index, all) => {
          const url = 'http://' + entry.address + ':' + (state.port || 0) + '/pair?c=' + minted.code;
          const other = all.find((candidate, candidateIndex) => candidateIndex !== index && candidate && candidate.address);
          const fallback = other ? '&u2=' + encodeURIComponent('http://' + other.address + ':' + (state.port || 0) + '/pair?c=' + minted.code) : '';
          return {
            name: entry.name,
            address: entry.address,
            url,
            deep: 'dshharness://pair?u=' + encodeURIComponent(url) + fallback,
          };
        }) : [];
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ code: minted.code, expiresAt: minted.expiresAt, ttlMs: PAIR_CODE_TTL_MS, networks }));
      }
    }));
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair/devices',
      handler: (request, response) => {
        const devices = BRIDGE_PAIRED.map((row) => ({ id: row.id, name: row.name, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt }));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ devices }));
      }
    }));
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/pair/revoke',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'allow': 'POST' });
          response.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        const chunks = [];
        request.on('data', (chunk) => { if (chunks.length < 32) chunks.push(chunk); });
        request.on('end', () => {
          let id = '';
          try { id = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).id || ''); } catch (error) { id = ''; }
          const removed = id !== '' && revokeDevice(id);
          /* A revoked device must not keep a delivery cursor around: it can never
             be reached again, and phone_state should not count it. */
          if (removed) PHONE_CURSORS.delete('device:' + id);
          response.writeHead(removed ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ ok: removed, id }));
        });
      }
    }));
    /* Agent -> phone command channel. The shell polls, executes and reports back;
       commands stay in memory so a restart simply drops what was never delivered. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/phone/pull',
      handler: (request, response) => {
        const commands = takePhoneCommands(phoneDeviceKey(request));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ commands }));
      }
    }));
    /* Admin cleanup for queued commands (test notifications, a stale blast). */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/phone/clear',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'allow': 'POST' });
          response.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        PHONE_QUEUE.length = 0;
        PHONE_CURSORS.clear();
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, pending: PHONE_QUEUE.length }));
      }
    }));

    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/phone/result',
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'allow': 'POST' });
          response.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        const chunks = [];
        request.on('data', (chunk) => { if (chunks.length < 16) chunks.push(chunk); });
        request.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            PHONE_RESULTS.push({
              id: String(parsed && parsed.id || ''),
              ok: Boolean(parsed && parsed.ok),
              detail: String(parsed && parsed.detail || '').slice(0, 200),
              at: Date.now(),
            });
            if (PHONE_RESULTS.length > 50) PHONE_RESULTS.shift();
          } catch (error) { /* malformed receipt */ }
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ ok: true }));
        });
      }
    }));
    /* Phone app: landing page, version manifest and the APK itself. Paired phones
       ask for version.json on launch and offer the download when it is newer. */
    inner.effect(() => inner.webServer.register({
      kind: 'exact',
      path: '/__ink/app',
      handler: (request, response) => {
        const meta = readAppMeta();
        const host = String(request.headers.host || '');
        const download = host ? 'http://' + host + '/__ink/app/' + APP_APK : '/__ink/app/' + APP_APK;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(renderAppPage(meta, download));
      }
    }));
    inner.effect(() => inner.webServer.register({
      kind: 'prefix',
      path: '/__ink/app',
      handler: (request, response) => {
        const pathname = String((request.url || '').split('?')[0]);
        const name = pathname.slice('/__ink/app/'.length);
        if (name === 'version.json') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify(readAppMeta()));
          return;
        }
        if (name === APP_APK || name === APP_APK + '.idsig') {
          serveAppFile(response, join(APP_DIR, name), name === APP_APK
            ? 'application/vnd.android.package-archive'
            : 'application/octet-stream');
          return;
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
      }
    }));
    inner.effect(() => inner.webServer.tapIndex((html) => {
      if (html.includes('data-dsh-ink-early')) return html;
      /* Android: let the layout viewport shrink with the soft keyboard so the
         composer stays above it instead of leaving a strip of page behind.
         No viewport-fit=cover on purpose: inside a normal browser tab it makes
         env(safe-area-inset-bottom) report the system navigation bar, which
         lands as dead space between the composer and the keyboard. */
      html = html.replace(/<meta name="viewport" content="[^"]*"/, '<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content"');
      /* No boot skin here: this plugin only fixes the mobile viewport. */
      const at = html.indexOf('</head>');
      return html;
    }));

    /* Turn-end notifications: the browser half subscribes to this stream. */
    inner.effect(() => startNotifyHub(inner));
  });

  ctx.inject(['webServer', 'connection'], (inner) => {
    inner.effect(() => {
      try {
        return startMobileBridge(inner);
      } catch (error) {
        try { ctx.logger && ctx.logger.warn && ctx.logger.warn('[mobile-bridge] disabled: ' + String((error && error.message) || error)); } catch (ignored) { /* ignore */ }
        return () => {};
      }
    });
  });
}


/* ------------------------------------------------------------------ bridge */

/**
 * Non-loopback IPv4 addresses a phone could reach, virtual LAN first.
 * @returns {{ name: string, address: string }[]}
 */
function reachableAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      found.push({ name, address: info.address });
    }
  }
  found.sort((left, right) => score(right) - score(left));
  return found;
}

function score(entry) {
  if (entry.address.startsWith('172.16.') || entry.address.startsWith('172.17.')) return 3;
  if (entry.address.startsWith('10.')) return 2;
  if (entry.address.startsWith('192.168.')) return 1;
  return 0;
}

/**
 * One directory listing for the phone's own workspace picker.
 * @param {string} wanted - absolute path; empty means the user profile.
 * @returns {{path: string, parent: string|null, dirs: string[], drives: string[], error: string|null}}
 */
function listDirectories(wanted) {
  const start = typeof wanted === 'string' && wanted.trim() !== ''
    ? wanted.trim()
    : (process.env.USERPROFILE || 'C:\\');
  let target;
  try {
    target = resolvePath(start);
  } catch (error) {
    return { path: start, parent: null, dirs: [], drives: driveRoots(), error: '路径无效' };
  }
  const parent = dirname(target);
  const answer = {
    path: target,
    parent: parent === target ? null : parent,
    dirs: [],
    drives: driveRoots(),
    error: null
  };
  try {
    answer.dirs = readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== '$RECYCLE.BIN' && entry.name !== 'System Volume Information')
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
      .slice(0, 400);
  } catch (error) {
    answer.error = String((error && error.message) || error);
  }
  return answer;
}

/** Drive letters that exist, so the picker can switch disks. */
function driveRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ':\\';
    try {
      if (existsSync(root)) roots.push(root);
    } catch (error) { /* unreadable drive */ }
  }
  return roots;
}

/**
 * Expose the loopback GUI on the private network with the upstream session
 * cookie attached server-side.
 * @param {{ webServer: object, connection: object }} inner - injected services.
 * @returns {() => void} disposer closing the listener.
 */
function startMobileBridge(inner) {
  const origin = new URL(inner.webServer.getOrigin());
  const upstreamPort = Number(origin.port);
  const upstreamHost = origin.host;
  const launchToken = readLaunchToken(inner.connection, origin.href);
  if (launchToken === undefined) return () => {};

  let cookie = '';
  let closed = false;
  const sockets = new Set();
  let server;

  /** Mint the browser-session cookie by exchanging this process's launch token. */
  const readCookie = () => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      method: 'GET',
      path: '/?token=' + encodeURIComponent(launchToken),
      headers: { host: upstreamHost }
    }, (response) => {
      const raw = response.headers['set-cookie'] || [];
      response.resume();
      resolve(raw.map((entry) => entry.split(';')[0]).join('; '));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('bridge auth timeout')));
    request.end();
  });

  const ensureCookie = async (refresh) => {
    if (!refresh && cookie !== '') return cookie;
    cookie = await readCookie();
    return cookie;
  };

  const cookieValue = (request, name) => {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return '';
    const wanted = name || BRIDGE_COOKIE;
    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === wanted) return part.slice(index + 1).trim();
    }
    return '';
  };
  const wantsKey = (request) => {
    if (deviceForToken(cookieValue(request, DEVICE_COOKIE)) !== undefined) return false;
    if (keyEquals(cookieValue(request, BRIDGE_COOKIE))) return false;
    const url = new URL(request.url || '/', 'http://bridge.invalid');
    return !keyEquals(url.searchParams.get('k') || '');
  };

  const forward = async (request, response, retried) => {
    if (closed) { response.destroy(); return; }
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === 'host' || name === 'cookie' || name === 'connection') continue;
      if (name === 'x-dsh-bridge-device') continue;
      headers[name] = value;
    }
    headers.host = upstreamHost;
    headers.cookie = await ensureCookie(retried);
    try {
      const device = deviceForToken(cookieValue(request, DEVICE_COOKIE));
      if (device && device.id) headers['x-dsh-bridge-device'] = device.id;
    } catch (error) { /* anonymous key session */ }
    headers['x-forwarded-host'] = request.headers.host || '';
    /* The GUI is same-origin with the upstream listener, so any CSRF-style
       origin check downstream must see that listener, not the phone address. */
    if (typeof headers.origin === 'string') headers.origin = origin.origin;
    if (typeof headers.referer === 'string') headers.referer = origin.origin + '/';
    const upstream = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers
    }, (answer) => {
      if (answer.statusCode === 401 && retried !== true && request.method === 'GET') {
        answer.resume();
        forward(request, response, true).catch(() => {
          try { response.destroy(); } catch (error) { /* ignore */ }
        });
        return;
      }
      const out = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (name === 'set-cookie' || name === 'connection' || name === 'keep-alive') continue;
        out[name] = value;
      }
      if (response.socket && typeof response.socket.setNoDelay === 'function') response.socket.setNoDelay(true);
      response.writeHead(answer.statusCode || 502, out);
      answer.pipe(response);
    });
    upstream.on('error', (error) => {
      const code = String((error && error.code) || '');
      const timedOut = code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT';
      try {
        if (!response.headersSent) {
          response.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        }
        response.end(JSON.stringify({
          error: timedOut ? 'upstream-timeout' : 'upstream-unreachable',
          code: code || 'unknown',
          detail: String((error && error.message) || error).slice(0, 200)
        }));
      } catch (ignored) { /* response already gone */ }
    });
    request.pipe(upstream);
  };

  const handler = (request, response) => {
    const url = new URL(request.url || '/', 'http://bridge.invalid');
    /* The browser fetches the web manifest and favicon out of band, without the
       page's cookie in some versions, and a 401 there only produces console
       noise. These files carry nothing secret, so they skip the key check. */
    const publicPath = url.pathname === '/manifest.webmanifest'
      || url.pathname === '/robots.txt'
      || url.pathname.startsWith('/favicon');
    if (url.pathname === '/__bridge') {
      /* Diagnostics expose the key and WS counters; never hand them to a LAN
         client that is not already authenticated. */
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientAddress(request));
      if (!local && wantsKey(request)) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'auth-required' }));
        return;
      }
      const address = server && server.address();
      const body = JSON.stringify({
        listening: !closed,
        port: address && address.port,
        key: BRIDGE_KEY,
        authFailures: AUTH_FAILURES.size,
        wsPaths: Object.fromEntries(WS_STATS),
        wsDenied: Object.fromEntries(WS_DENIED),
        devices: BRIDGE_DEVICES.size,
        pairedDevices: BRIDGE_PAIRED.length,
        pairingCodes: PAIR_CODES.size
      }, null, 2);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
      return;
    }
    const pairCode = url.searchParams.get('c');
    if (pairCode !== null && pairCode !== '') {
      const redeemed = redeemPairCode(pairCode);
      if (redeemed.error) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: redeemed.error }));
        return;
      }
      clearAuthFailures(request);
      recordDevice(request);
      const rest = new URLSearchParams(url.searchParams);
      rest.delete('c');
      const query = rest.toString();
      response.writeHead(302, {
        location: url.pathname + (query === '' ? '' : '?' + query),
        'set-cookie': DEVICE_COOKIE + '=' + redeemed.token + '; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly',
        'cache-control': 'no-store'
      });
      response.end();
      return;
    }
    if (!publicPath && wantsKey(request)) {
      const waitMs = authBlockedFor(request);
      if (waitMs > 0) {
        response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(Math.ceil(waitMs / 1000)) });
        response.end(JSON.stringify({ error: 'rate-limited', retryAfterMs: waitMs }));
        return;
      }
      recordAuthFailure(request);
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>DSH mobile bridge</title>'
        + '<body style="font:14px/1.6 system-ui;color:#131316;background:#fafaf9;padding:40px">'
        + '<h1 style="font-size:15px;font-weight:600">needs the link with the key</h1>'
        + '<p style="color:#6a6a70">This listener only opens for a URL carrying the one-time '
        + '?k= parameter; the browser then keeps it in a cookie.</p>'
        + '</body>');
      return;
    }
    if (keyEquals(url.searchParams.get('k') || '')) {
      clearAuthFailures(request);
      recordDevice(request);
      const rest = new URLSearchParams(url.searchParams);
      rest.delete('k');
      const query = rest.toString();
      response.writeHead(302, {
        location: url.pathname + (query === '' ? '' : '?' + query),
        'set-cookie': BRIDGE_COOKIE + '=' + BRIDGE_KEY + '; Path=/; Max-Age=31536000; SameSite=Lax',
        'cache-control': 'no-store'
      });
      response.end();
      return;
    }
    recordDevice(request);
    forward(request, response, false).catch((error) => {
      try {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('mobile bridge: ' + String((error && error.message) || error));
      } catch (ignored) { /* response already gone */ }
    });
  };

  server = http.createServer({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 600000 }, handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (authBlockedFor(request) > 0 || wantsKey(request)) {
      recordAuthFailure(request);
      try { socket.destroy(); } catch (error) { /* ignore */ }
      return;
    }
    const wsPath = new URL(request.url || '/', 'http://bridge.invalid').pathname;
    bumpCounter(WS_STATS, wsPath);
    /* Only the paths the GUI itself opens; a plugin-injected or future route must
       opt in explicitly instead of riding the bridge. */
    const wsAllowed = WS_ALLOW_PREFIXES.some((prefix) => wsPath === prefix || wsPath.startsWith(prefix));
    if (!wsAllowed) {
      bumpCounter(WS_DENIED, wsPath);
      try { socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); } catch (error) { /* ignore */ }
      try { socket.destroy(); } catch (error) { /* ignore */ }
      return;
    }
    const lines = ['GET ' + request.url + ' HTTP/1.1', 'Host: ' + upstreamHost, 'Connection: Upgrade'];
    if (request.headers.upgrade) lines.push('Upgrade: ' + request.headers.upgrade);
    if (request.headers['sec-websocket-key']) lines.push('Sec-WebSocket-Key: ' + request.headers['sec-websocket-key']);
    if (request.headers['sec-websocket-version']) lines.push('Sec-WebSocket-Version: ' + request.headers['sec-websocket-version']);
    if (request.headers['sec-websocket-protocol']) lines.push('Sec-WebSocket-Protocol: ' + request.headers['sec-websocket-protocol']);
    if (request.headers['sec-websocket-extensions']) lines.push('Sec-WebSocket-Extensions: ' + request.headers['sec-websocket-extensions']);
    lines.push('Origin: ' + origin.origin);
    ensureCookie(false).then((value) => {
      if (value !== '') lines.push('Cookie: ' + value);
      const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => { try { socket.destroy(); } catch (error) { /* ignore */ } });
      socket.on('error', () => { try { upstream.destroy(); } catch (error) { /* ignore */ } });
    }).catch(() => { try { socket.destroy(); } catch (error) { /* ignore */ } });
  });

  /* Addresses move when Wi-Fi or the VPN changes, so the published state is
     rebuilt from the live interface list instead of being frozen at listen
     time. startedAt stays fixed so repeated publishes compare equal. */
  const startedAt = new Date().toISOString();
  let lastPublished = '';
  const publish = (port) => {
    bridgePort = port;
    const addresses = reachableAddresses();
    const state = {
      origin: origin.href,
      port,
      key: BRIDGE_KEY,
      urls: addresses.map((entry) => 'http://' + entry.address + ':' + port + '/?k=' + BRIDGE_KEY),
      addresses,
      startedAt,
      pid: process.pid
    };
    const json = JSON.stringify(state, null, 2);
    if (json !== lastPublished) {
      lastPublished = json;
      try { writeFileSync(BRIDGE_STATE_FILE, json, 'utf8'); } catch (error) { /* best effort */ }
      try { writeFileSync(BRIDGE_KEY_FILE, BRIDGE_KEY, 'utf8'); } catch (error) { /* best effort */ }
    }
    return state;
  };

  let attempt = 0;
  let refreshTimer = null;
  const listen = () => {
    const port = BRIDGE_PORTS[attempt];
    if (port === undefined) return;
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        attempt += 1;
        setTimeout(listen, 30);
      }
    });
    server.listen(port, '0.0.0.0', () => {
      server.removeAllListeners('error');
      server.on('error', () => { /* keep serving */ });
      publish(port);
      /* Re-read the interfaces so a Wi-Fi switch shows up in the pairing panel
         without restarting DSH. */
      refreshTimer = setInterval(() => {
        if (closed) return;
        try { publish(port); } catch (error) { /* keep serving */ }
      }, 12000);
      if (refreshTimer.unref) refreshTimer.unref();
    });
  };
  listen();

  return () => {
    closed = true;
    if (refreshTimer) clearInterval(refreshTimer);
    bridgePort = 0;
    try { server.close(); } catch (error) { /* ignore */ }
    for (const socket of sockets) {
      try { socket.destroy(); } catch (error) { /* ignore */ }
    }
    try {
      writeFileSync(BRIDGE_STATE_FILE, JSON.stringify({ stoppedAt: new Date().toISOString(), origin: origin.href }, null, 2), 'utf8');
    } catch (error) { /* ignore */ }
  };
}

/**
 * Read this process's browser launch token from the connection service.
 * @param {object} connection - host connection service.
 * @param {string} base - loopback origin.
 * @returns {string | undefined} the token, when the transport exposes it.
 */
function readLaunchToken(connection, base) {
  try {
    const authenticated = connection.authenticatedUrl(base);
    const token = new URL(authenticated).searchParams.get('token');
    return token === null ? undefined : token;
  } catch (error) {
    return undefined;
  }
}

/* ---------------------------------------------------------- desktop notice */

/**
 * Short human duration for the notification body.
 * @param {number} milliseconds - elapsed time.
 * @returns {string} readable span, empty when unknown.
 */
function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  const total = Math.round(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? minutes + ' 分 ' + seconds + ' 秒' : seconds + ' 秒';
}

/**
 * Windows notice script. Runs in Windows PowerShell (WinRT is only reachable
 * there), skips entirely when the Harness window is already in front because
 * the user is watching the answer stream, and otherwise raises a toast with a
 * tray balloon fallback plus the system notification sound.
 */
const NOTICE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$title = '__TITLE__'
$body = '__BODY__'
Add-Type -AssemblyName System
$wav = 'C:\\Windows\\Media\\Windows Notify System Generic.wav'
$player = $null
if (Test-Path $wav) { try { $player = New-Object System.Media.SoundPlayer -ArgumentList $wav } catch { $player = $null } }
if ($player -ne $null) { $player.PlaySync() } else { try { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900 } catch { } }
`;

/**
 * Raise one desktop notice without blocking the Host.
 * @param {string} title - bold first line.
 * @param {string} body - second line.
 */
function fireDesktopNotice(title, body, force) {
  try {
    const escape = (value) => String(value === undefined || value === null ? '' : value).replace(/'/g, "''");
    const script = NOTICE_SCRIPT
      .replace('__TITLE__', escape(title))
      .replace('__BODY__', escape(body))
      .replace('__FORCE__', force === true ? '$true' : '$false');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try { appendBounded(HELLO_FILE, new Date().toISOString() + ' notice ' + String(title) + ' | ' + String(body) + '\n'); } catch (error) { /* best effort */ }
    /* the toast carries the sound now; the host no longer spawns a player. */
    if (false) spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) { /* notifications are best effort */ }
}

/* -------------------------------------------------------------- notifies */

/**
 * Turn-end notification hub.
 *
 * The Host knows exactly when a turn closes (`agent/turn-stopping`), but it is a
 * Node process and cannot raise an OS notification. The browser half can, so
 * this exposes a small server-sent event stream that the page subscribes to; the
 * client turns each frame into a Windows toast plus an in-app pill. Root agents
 * only, so subagents and teammates do not spam the stream.
 * @param {object} ctx - injected host context carrying webServer.
 * @returns {() => void} disposer ending every open stream.
 */
function startNotifyHub(ctx) {
  /* Hub state is module-level and survives plugin reloads: a reload disposes
     routes and listeners, and a half-disposed instance must never keep a
     private copy of the counters or the last event. */
  const shared = globalThis.__DSH_NOTIFY_HUB__ || (globalThis.__DSH_NOTIFY_HUB__ = {
    streams: new Set(),
    latest: { seq: 0, type: 'none', title: '', at: 0 },
    polls: 0,
    titles: new Map(),
    started: new Map(),
    fired: new Map(),
    uiFocused: false
  });

  const push = (payload) => {
    const key = String(payload.sessionId || '');
    const now = Date.now();
    const previous = shared.fired.get(key) || 0;
    if (payload.type === 'turn-end' && now - previous < 4000) return;
    shared.fired.set(key, now);
    shared.latest = Object.assign({ seq: shared.latest.seq + 1, at: now }, payload);
    const frame = 'data: ' + JSON.stringify(shared.latest) + '\n\n';
    for (const stream of shared.streams) {
      try { stream.write(frame); } catch (error) { shared.streams.delete(stream); }
    }
  };

  const handler = (request, response) => {
    const url = new URL(request.url || '/', 'http://notify.invalid');
    if (url.pathname.endsWith('/dump')) {
      var chunks = [];
      request.on('data', function (chunk) { chunks.push(chunk); });
      request.on('end', function () {
        try {
          appendBounded(DUMP_FILE, '\n---- ' + new Date().toISOString() + ' ----\n' + Buffer.concat(chunks).toString('utf8') + '\n', 256 * 1024);
        } catch (error) { /* best effort */ }
        response.writeHead(204);
        response.end();
      });
      return;
    }
    if (url.pathname.endsWith('/hello')) {
      try {
        appendBounded(HELLO_FILE, new Date().toISOString() + ' ' + request.url + '\n');
      } catch (error) { /* best effort */ }
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname.endsWith('/notify/focus')) {
      var focusChunks = [];
      request.on('data', function (chunk) { focusChunks.push(chunk); });
      request.on('end', function () {
        var focused = false;
        try { focused = JSON.parse(Buffer.concat(focusChunks).toString('utf8')).focused === true; } catch (error) { focused = false; }
        shared.uiFocused = focused;
        response.writeHead(204);
        response.end();
      });
      return;
    }
    if (url.pathname.endsWith('/last')) {
      shared.polls += 1;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(shared.latest));
      return;
    }
    if (url.pathname.endsWith('/state')) {
      const body = JSON.stringify({ streams: shared.streams.size, titles: shared.titles.size, polls: shared.polls, uiFocused: shared.uiFocused, pid: process.pid }, null, 2);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }
    if (url.pathname.endsWith('/test')) {
      fireDesktopNotice('DSH · 测试通知', '宿主侧通知链路正常，这一条是我手动触发的', true);
      push({ type: 'turn-end', sessionId: 'test', title: '测试通知', test: true, at: Date.now() });
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('sent');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    try {
      appendBounded(HELLO_FILE, new Date().toISOString() + ' stream ua=' + JSON.stringify(request.headers['user-agent'] || '') + ' origin=' + JSON.stringify(request.headers.origin || '') + ' referer=' + JSON.stringify(request.headers.referer || '') + '\n');
    } catch (error) { /* best effort */ }
    response.write(': connected\n\n');
    shared.streams.add(response);
    const ping = setInterval(() => {
      try { response.write(': ping\n\n'); } catch (error) { /* stream already gone */ }
    }, 20000);
    const close = () => {
      clearInterval(ping);
      shared.streams.delete(response);
      try { response.end(); } catch (error) { /* already closed */ }
    };
    /* Only the response lifetime matters: an IncomingMessage also emits 'close'
       when the request body is consumed, which would drop a live stream. */
    response.on('close', close);
  };

  const disposers = [
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify/test', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify/state', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify/focus', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify/last', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/notify/hello', handler })),
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/__ink/dump', handler }))
  ];

  /* Root sessions only: a child session's turn end should not notify the phone.
     The session header carries the parent link, so use that instead of guessing. */
  const isRoot = (agent) => {
    try {
      const store = ctx.get('sessions');
      const session = store && typeof store.get === 'function' && agent ? store.get(String(agent.id || agent.sessionId || '')) : undefined;
      if (session && session.header && session.header.parentSession) return false;
      return true;
    } catch (error) {
      return true;
    }
  };

  const describe = (agent) => {
    const id = agent && (agent.id || agent.sessionId);
    const key = id === undefined ? '' : String(id);
    let title = shared.titles.get(key) || '';
    let cwd = '';
    try {
      const store = ctx.get('sessions');
      const titlesService = ctx.get('sessionTitle');
      const session = store && typeof store.get === 'function' ? store.get(key) : undefined;
      if (session && session.header && typeof session.header.cwd === 'string') cwd = session.header.cwd;
      const snapshot = session && titlesService && typeof titlesService.get === 'function'
        ? titlesService.get(session)
        : undefined;
      if (title === '' && typeof snapshot === 'string') title = snapshot;
      else if (title === '' && snapshot) title = String(snapshot.title || snapshot.text || snapshot.label || '');
    } catch (error) { /* title is optional */ }
    return { sessionId: key, title, cwd };
  };

  const send = (payload) => push(payload);

  disposers.push(ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const agent = payload && payload.agent;
      const id = agent && (agent.id || agent.sessionId);
      if (id !== undefined) shared.started.set(String(id), Date.now());
    } catch (error) { /* ignore */ }
  }));

  disposers.push(ctx.on('api-session/added', (summary) => {
    try {
      if (!summary) return;
      const id = summary.id || summary.sessionId;
      if (id !== undefined && typeof summary.title === 'string') shared.titles.set(String(id), summary.title);
    } catch (error) { /* ignore */ }
  }));

  disposers.push(ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload && payload.agent;
    if (!isRoot(agent)) return;
    const info = describe(agent);
    const startedAt = shared.started.get(info.sessionId) || 0;
    const spent = startedAt === 0 ? '' : '用时 ' + formatDuration(Date.now() - startedAt);
    shared.started.delete(info.sessionId);
    /* let the final assistant message paint before the toast fires */
    setTimeout(() => {
      /* The phone always needs the event; the Windows toast is noise while the user
         is already looking at the app. */
      if (!shared.uiFocused) fireDesktopNotice('DSH · 这一轮结束了', info.title !== '' ? info.title : (spent !== '' ? spent : '可以回来看结果了'));
      send({ type: 'turn-end', sessionId: info.sessionId, title: info.title, cwd: info.cwd, at: Date.now() });
    }, 350);
  }));

  disposers.push(ctx.on('agent/error', (payload) => {
    const agent = payload && payload.agent;
    if (!isRoot(agent)) return;
    const info = describe(agent);
    setTimeout(() => {
      fireDesktopNotice('DSH · 这一轮出错了', info.title !== '' ? info.title : '打开窗口看看错误信息');
      send({ type: 'turn-error', sessionId: info.sessionId, title: info.title, cwd: info.cwd, at: Date.now() });
    }, 350);
  }));

  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose(); } catch (error) { /* ignore */ }
    }
    for (const stream of [...shared.streams]) {
      try { stream.end(); } catch (error) { /* ignore */ }
    }
    shared.streams.clear();
  };
}

/* ------------------------------------------------------------- pairing page */

const PAIR_STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0a0a0b;color:#f2f2f3;
  font:14px/1.65 -apple-system,'Segoe UI',system-ui,'Microsoft YaHei',sans-serif}
.wrap{max-width:780px;margin:0 auto;padding:26px 18px 56px}
h1{font-size:18px;font-weight:600;margin:0 0 6px}
.sub{color:#8a8a90;font-size:13px;margin:0 0 22px}
.card{border:1px solid #232327;border-radius:14px;padding:16px;margin:0 0 14px;background:#101012}
.card h2{font-size:14px;font-weight:600;margin:0 0 2px}
.addr{color:#8a8a90;font-size:12px;margin:0 0 14px;word-break:break-all}
.qrs{display:flex;gap:16px;flex-wrap:wrap}
figure{margin:0;flex:1 1 190px;max-width:240px;text-align:center}
figure svg{width:100%;height:auto;background:#fff;border-radius:10px;padding:6px;display:block}
figcaption{color:#8a8a90;font-size:12px;margin-top:6px}
.note{color:#8a8a90;font-size:12px}
`;

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Reads the manifest `_android/build.ps1` writes beside the APK.
 * @returns {{version: string, versionCode: number, builtAt: string, size: number}}
 */
function readAppMeta() {
  try {
    const raw = readFileSync(join(APP_DIR, 'version.json'), 'utf8').replace(/^\uFEFF/, '');
    const meta = JSON.parse(raw);
    return {
      version: String(meta.version || ''),
      versionCode: Number(meta.versionCode) || 0,
      builtAt: String(meta.builtAt || ''),
      size: Number(meta.size) || 0
    };
  } catch (error) {
    return { version: '', versionCode: 0, builtAt: '', size: 0 };
  }
}

/**
 * Streams one APK file with no caching, so a rebuilt APK is never mistaken for
 * the previous build by a phone that already downloaded it once.
 * @param {import('node:http').ServerResponse} response - route response.
 * @param {string} file - absolute path.
 * @param {string} type - content type.
 */
function serveAppFile(response, file, type) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'no-store'
    });
    createReadStream(file).pipe(response);
  } catch (error) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('APK 还没构建：先跑一遍 _android/build.ps1');
  }
}

/**
 * @param {object} meta - readAppMeta() result.
 * @param {string} download - absolute APK URL the QR encodes.
 * @returns {string} the download page as HTML.
 */
function renderAppPage(meta, download) {
  const size = meta.size ? Math.round(meta.size / 1024) + ' KB' : '';
  const built = meta.builtAt ? escapeHtml(meta.builtAt) : '';
  const version = meta.version ? escapeHtml(meta.version) : '未构建';
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>DSH 手机版</title>'
    + '<style>body{margin:0;background:#0a0a0b;color:#f2f2f3;font:15px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}'
    + '.wrap{max-width:420px;margin:0 auto;padding:28px 22px 40px}h1{font-size:19px;font-weight:600;margin:0 0 6px}'
    + '.meta{color:#8a8a90;font-size:13px;margin:0 0 22px}'
    + 'a.btn{display:block;text-align:center;background:#f2f2f3;color:#0a0a0b;text-decoration:none;'
    + 'font-weight:600;padding:13px 18px;border-radius:10px;margin:0 0 18px}'
    + '.qr{background:#fff;border-radius:12px;padding:12px;width:max-content;margin:0 auto 14px}'
    + '.qr svg{display:block;width:180px;height:180px}'
    + '.hint{color:#8a8a90;font-size:12px;text-align:center;margin:0}</style>'
    + '<div class="wrap"><h1>DSH 手机版</h1>'
    + '<p class="meta">版本 ' + version + (size ? ' · ' + size : '') + (built ? ' · ' + built : '') + '</p>'
    + '<a class="btn" href="/__ink/app/' + APP_APK + '">下载 APK</a>'
    + '<div class="qr">' + qrSvgOf(download) + '</div>'
    + '<p class="hint">扫码下载。装好后用配对页的二维码配对；安装前需允许“安装未知应用”。</p>'
    + '</div>';
}
function qrSvgOf(text) {
  try {
    const qr = qrcodeFactory(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag(5, 2, '');
  } catch (error) {
    return '<div style="padding:20px;color:#8a8a90">二维码生成失败</div>';
  }
}

/**
 * @param {object|null} state - bridge state written by startMobileBridge.
 * @returns {string} the pairing screen as HTML.
 */
function renderPairPage(state) {
  const port = state && Number(state.port) ? Number(state.port) : 0;
  const key = state && typeof state.key === 'string' ? state.key : '';
  const addresses = state && Array.isArray(state.addresses) ? state.addresses : [];
  const cards = [];

  for (const entry of addresses) {
    if (!entry || typeof entry.address !== 'string') continue;
    const direct = 'http://' + entry.address + ':' + port + '/?k=' + key;
    const deep = 'dshharness://pair?u=' + encodeURIComponent(direct);
    cards.push('<section class="card">'
      + '<h2>' + escapeHtml(entry.name || '网络') + '</h2>'
      + '<p class="addr">' + escapeHtml(direct) + '</p>'
      + '<div class="qrs">'
      + '<figure>' + qrSvgOf(direct) + '<figcaption>扫码用浏览器打开</figcaption></figure>'
      + '<figure>' + qrSvgOf(deep) + '<figcaption>装过应用：扫这个直接配对</figcaption></figure>'
      + '</div></section>');
  }

  if (cards.length === 0) {
    cards.push('<section class="card"><h2>桥接没有启动</h2>'
      + '<p class="addr">手机上还连不了：插件这半边没跑起来，或者还没有可用的局域网地址。</p></section>');
  }

  return '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>配对 · DeepSeek Harness</title><style>' + PAIR_STYLE + '</style>'
    + '<div class="wrap"><h1>手机配对</h1>'
    + '<p class="sub">用手机相机扫下面任意一个码。手机和电脑要能互相访问：连着蒲公英组网就扫 172.16 那条，'
    + '同一个 Wi-Fi 就扫 10.x 那条。</p>'
    + cards.join('')
    + '<p class="note">码里带着连接密钥，别截图发到公开的地方。</p></div>';
}


/** Bridge coordinates as plain data, shared by the page and the app panel. */
function pairState() {
  let state = null;
  try { state = JSON.parse(readFileSync(BRIDGE_STATE_FILE, 'utf8')); } catch (error) { /* bridge not up */ }
  /* The port survives in the file, but the addresses are read live: switching
     Wi-Fi or the VPN changes them while DSH keeps running. */
  const port = bridgePort || (state && Number.isFinite(Number(state.port)) ? Number(state.port) : 0);
  const key = state && typeof state.key === 'string' ? state.key : '';
  const addresses = port && key ? reachableAddresses() : [];
  const usable = addresses.filter((entry) => entry && typeof entry.address === 'string');
  const devices = [...BRIDGE_DEVICES.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, DEVICE_LIMIT);
  let app = null;
  try { app = readAppMeta(); } catch (error) { /* APK not built yet */ }
  const paired = BRIDGE_PAIRED.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  }));
  return {
    listening: Boolean(port && key),
    port,
    key,
    devices,
    paired,
    app,
    networks: usable.map((entry, index) => {
      const url = 'http://' + entry.address + ':' + port + '/?k=' + key;
      /* The app tries u first and falls back to u2, so a phone that is on Wi-Fi
         but not on the VPN still pairs with one scan. */
      const others = usable.filter((other, otherIndex) => otherIndex !== index);
      const fallback = others.length > 0
        ? '&u2=' + encodeURIComponent('http://' + others[0].address + ':' + port + '/?k=' + key)
        : '';
      return {
        name: entry.name || '网络',
        address: entry.address,
        url,
        deep: 'dshharness://pair?u=' + encodeURIComponent(url) + fallback
      };
    })
  };
}

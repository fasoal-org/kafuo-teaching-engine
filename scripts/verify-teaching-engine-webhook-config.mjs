#!/usr/bin/env node
/**
 * Non-secret connectivity check for the OpenMAIC → Kafuo webhook integration.
 *
 * Reports exactly five facts and nothing else:
 *
 *   service key: present/missing
 *   webhook secret: present/missing
 *   cross-application webhook secret: match/mismatch
 *   webhook URL: valid/invalid
 *   Kafuo webhook route: registered/missing
 *
 * It never prints a secret value, a length, a prefix, or a hash — a hash of a
 * shared secret is itself reusable material for an offline guess, so the
 * cross-application comparison happens in memory and only the verdict is shown.
 *
 * The route check needs no credential at all: an unsigned POST to the
 * configured URL must answer 401 (the route exists and refused the signature).
 * A 404 means the path is not served — the original failure mode, when the
 * receiver was mounted under a second `/api/v2` prefix.
 *
 *   node scripts/verify-teaching-engine-webhook-config.mjs
 *
 * Exit code 0 when every line is the good value, 1 otherwise, so it can gate a
 * local bring-up script.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENMAIC_ROOT = resolve(HERE, '..');
const BACKEND_ROOT = resolve(OPENMAIC_ROOT, '..', 'zakrly-backend');

/** Parse `KEY=value` lines. Values stay in memory and are never printed. */
async function readEnvFile(path) {
  try {
    const text = await readFile(path, 'utf8');
    const values = new Map();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
    return values;
  } catch {
    return new Map();
  }
}

function pick(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** https anywhere; explicit loopback http is accepted for local development. */
function webhookUrlIsValid(rawUrl) {
  if (!rawUrl) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/**
 * Registered when an UNSIGNED POST is refused for its signature (401) rather
 * than for its path (404). No credential is sent.
 */
async function probeRoute(rawUrl) {
  if (!webhookUrlIsValid(rawUrl)) return 'missing';
  try {
    const response = await fetch(rawUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return 'missing';
    // 401 is the expected answer; anything else that is not 404 still proves a
    // handler is mounted at this path.
    return 'registered';
  } catch {
    // Unreachable is not the same as unregistered; say so without guessing.
    return 'unreachable';
  }
}

const openmaicEnv = await readEnvFile(join(OPENMAIC_ROOT, '.env.local'));
const backendEnv = await readEnvFile(join(BACKEND_ROOT, '.env'));

const serviceKey = pick(
  process.env.TEACHING_ENGINE_SERVICE_KEY,
  openmaicEnv.get('TEACHING_ENGINE_SERVICE_KEY'),
);
const webhookSecret = pick(
  process.env.TEACHING_ENGINE_WEBHOOK_SECRET,
  openmaicEnv.get('TEACHING_ENGINE_WEBHOOK_SECRET'),
);
const backendWebhookSecret = pick(backendEnv.get('TEACHING_ENGINE_WEBHOOK_SECRET'));
const webhookUrl = pick(
  process.env.TEACHING_ENGINE_WEBHOOK_URL,
  openmaicEnv.get('TEACHING_ENGINE_WEBHOOK_URL'),
);

const lines = [];
let ok = true;

const record = (label, value, good) => {
  lines.push(`${label}: ${value}`);
  if (!good) ok = false;
};

record('service key', serviceKey ? 'present' : 'missing', Boolean(serviceKey));
record('webhook secret', webhookSecret ? 'present' : 'missing', Boolean(webhookSecret));

// Compared in memory; only the verdict is emitted.
const bothPresent = Boolean(webhookSecret) && Boolean(backendWebhookSecret);
const secretsMatch = bothPresent && webhookSecret === backendWebhookSecret;
record(
  'cross-application webhook secret',
  bothPresent ? (secretsMatch ? 'match' : 'mismatch') : 'mismatch',
  secretsMatch,
);

const urlValid = webhookUrlIsValid(webhookUrl);
record('webhook URL', urlValid ? 'valid' : 'invalid', urlValid);

const routeState = await probeRoute(webhookUrl);
record('Kafuo webhook route', routeState, routeState === 'registered');

// Also a real misconfiguration, and reportable without revealing anything.
if (serviceKey && webhookSecret && serviceKey === webhookSecret) {
  lines.push('webhook secret reuses the service key: yes');
  ok = false;
}

console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);

/**
 * Canonical JSON + request digest for the legacy help-turn endpoint
 * (Kafuo R1 contracts §3.4).
 *
 * MUST match the Backend byte for byte. It computes
 *   `sha256(json.dumps(body_without_actorRef_and_requestDigest,
 *                      sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))`
 * (`teaching_engine_help_generation_provider.py`). So here: strip BOTH
 * `actorRef` and `requestDigest` at the top level, sort object keys
 * recursively by code point (Python compares `str` by code point), no
 * whitespace, raw UTF-8 (no `\uXXXX` for non-ASCII), `null` preserved,
 * integers as plain integers.
 *
 * `JSON.stringify` already escapes exactly the characters Python does
 * (`"`, `\`, the C0 controls as `\b \f \n \r \t` or lowercase `\u00xx`)
 * and leaves everything else raw, so per-scalar serialisation is delegated
 * to it; only ordering and key stripping are ours.
 */
import { createHash } from 'node:crypto';

const STRIPPED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['actorRef', 'requestDigest']);

function compareByCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0)!;
    const cb = nb.value.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON: non-finite number');
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareByCodePoint);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON: unsupported value of type ${typeof value}`);
}

/** Python `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

/** The body minus `actorRef` and `requestDigest`, canonicalised. */
export function canonicalHelpTurnRequest(body: Record<string, unknown>): string {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (STRIPPED_TOP_LEVEL_KEYS.has(key)) continue;
    stripped[key] = value;
  }
  return canonicalJson(stripped);
}

/** Lowercase sha256 hex of the canonical UTF-8 bytes. */
export function computeHelpTurnDigest(body: Record<string, unknown>): string {
  return createHash('sha256').update(Buffer.from(canonicalHelpTurnRequest(body), 'utf8')).digest('hex');
}

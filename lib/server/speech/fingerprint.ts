/**
 * Audio fingerprint (plan §13.3, FR-024): a canonical hash of every material
 * input. `policyVersion` is deliberately not an input — its effect enters
 * through `preparedDigest` (and `deliveryDigest`), so a policy bump that does
 * not change an Action's prepared text keeps that audio current (AS-007).
 * Non-material fields (generatedAt, reason, ids, titles, playback speed) are
 * excluded.
 */
import { createHash } from 'node:crypto';

export const FINGERPRINT_VERSION = 'satts-fp-1';
export const SEGMENTATION_VERSION = 'seg-v1';

export interface FingerprintInputs {
  originalText: string;
  /** sha256 hex of the joined provider-bound prepared text. */
  preparedDigest: string;
  subjectCode: string | null;
  language: string | null;
  readingMode: 'natural' | 'accessible';
  providerId: string;
  modelId: string;
  voice: string;
  speed: number;
  responseFormat: string;
  deliveryDigest: string | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeFingerprint(inputs: FingerprintInputs): string {
  // Only the declared material fields are hashed, whatever else the caller holds.
  const canonical = canonicalJson({
    v: FINGERPRINT_VERSION,
    originalText: inputs.originalText,
    preparedDigest: inputs.preparedDigest,
    subjectCode: inputs.subjectCode,
    language: inputs.language,
    readingMode: inputs.readingMode,
    providerId: inputs.providerId,
    modelId: inputs.modelId,
    voice: inputs.voice,
    speed: inputs.speed,
    responseFormat: inputs.responseFormat,
    deliveryDigest: inputs.deliveryDigest,
    segmentation: SEGMENTATION_VERSION,
  });
  return `fp1:${createHash('sha256').update(canonical, 'utf8').digest('base64url')}`;
}

/** The 12-character prefix used in content-addressed file names. */
export function fingerprintPrefix(fingerprint: string): string {
  return fingerprint.replace(/^fp1:/, '').slice(0, 12);
}

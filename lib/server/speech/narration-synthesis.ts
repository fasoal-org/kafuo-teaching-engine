/**
 * Narration Synthesis Service (plan §13): the single place provider-bound
 * narration passes through. The route, the classroom batch and the agent
 * runtime all call it; the drift-guard test keeps it that way (plan §6).
 *
 *   plan:   context + profile → render → segment → fingerprint   (pure)
 *   assess: stored audio vs the plan → current | stale | legacy | missing
 *   synthesize: segments → provider (sequential) → completion check → join
 *               → persist (optional) → provenance → usage → outcome event
 *
 * With `SCIENTIFIC_TTS_MODE=off` the plan is the identity with today's
 * profile and request shape: nothing is rendered, segmented or retried beyond
 * what the caller already did (goal-prompt constraint 4, DEC-002).
 */
import { createHash } from 'node:crypto';

import { getEncoding, type Tiktoken } from 'js-tiktoken';

import {
  generateTTS,
  TTSInvalidResponseError,
  TTSRateLimitError,
  TTSRequestTimeoutError,
} from '@/lib/audio/tts-providers';
import type { TTSModelConfig, TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { renderScientificSpeech } from '@/lib/speech/scientific';
import type { SpeechContext } from '@/lib/speech/scientific/context';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';
import type { RenderedSpan } from '@/lib/speech/scientific/result';
import { makeWarning, type RenderWarning } from '@/lib/speech/scientific/warnings';
import { sanitizeAudioProvenance, type SpeechAction, type SpeechAudioProvenance } from '@/lib/types/action';
import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { joinAudio, AudioConcatError } from './audio-concat';
import type { SpeechConfig } from './config';
import { deliveryDigest, sha256Hex } from './delivery-instructions';
import { computeFingerprint, fingerprintPrefix } from './fingerprint';
import { writeNarrationAudio } from './narration-audio-store';
import { TOKEN_CAP_MARGIN } from './provider-capabilities';
import { segmentPrepared, type PreparedSegment } from './segment-prepared';
import type { SpeechProfile } from './speech-profile';

const log = createLogger('SpeechNarration');

export type NarrationEntry = 'route' | 'batch' | 'agent' | 'dynamic' | 'preview';
export type SynthesisReason = 'initial' | 'stale' | 'manual' | 'policy' | 'repair' | 'dynamic' | 'preview';
export type StaleReason =
  | 'text'
  | 'prepared'
  | 'subject'
  | 'language'
  | 'mode'
  | 'provider'
  | 'voice'
  | 'model'
  | 'speed'
  | 'format'
  | 'delivery'
  | 'experimental';

export type NarrationErrorCode =
  | 'SATTS_E_EMPTY_RESULT'
  | 'SATTS_E_SEGMENT_UNSPLITTABLE'
  | 'SATTS_E_PROVIDER_INCOMPLETE'
  | 'SATTS_E_PROVIDER_TRUNCATED'
  | 'SATTS_E_CONTEXT_UNAVAILABLE'
  | 'SATTS_E_PROVIDER_FAILED'
  | 'SATTS_E_JOIN_FAILED';

export class NarrationSynthesisError extends Error {
  constructor(
    public readonly code: NarrationErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NarrationSynthesisError';
  }
}

let encoder: Tiktoken | null = null;

/** `o200k_base` token count — equals the provider's count (Wave 0, M2). */
export function countTokens(text: string): number {
  encoder ??= getEncoding('o200k_base');
  return encoder.encode(text).length;
}

export interface NarrationPlan {
  path: 'general' | 'scientific';
  /** The exact text that will be sent (joined segments). */
  sentText: string;
  segments: PreparedSegment[];
  spans: RenderedSpan[];
  warnings: RenderWarning[];
  blocking: { code: NarrationErrorCode; message: string } | null;
  policyVersion: string | null;
  policyStatus: 'approved' | 'experimental';
  subjectCode: string | null;
  stageSubjectCode: string | null;
  language: string | null;
  readingMode: 'natural' | 'accessible';
  fingerprint: string;
  originalDigest: string;
  preparedDigest: string;
  deliveryDigest: string | null;
  responseFormat: string;
  /** Shadow mode only: what the scientific path would have sent. */
  shadowPrepared?: string;
}

export function planNarration(input: {
  text: string;
  context: SpeechContext;
  stageSubjectCode: string | null;
  profile: SpeechProfile;
  config: SpeechConfig;
  /**
   * Diagnostics/evaluation only: speak `proposed` dictionary entries (marked
   * experimental). Production generation never sets this (plan §11).
   */
  allowProposed?: boolean;
}): NarrationPlan {
  const { text, context, profile, config } = input;
  const scientific = config.mode === 'on' && context.subjectCode !== null;
  let sentText = text;
  let spans: RenderedSpan[] = [
    {
      kind: 'prose',
      source: { start: 0, end: text.length },
      prepared: { start: 0, end: text.length },
      atomic: false,
      fallback: false,
    },
  ];
  let warnings: RenderWarning[] = [];
  let blocking: NarrationPlan['blocking'] = null;
  let policyVersion: string | null = null;
  let policyStatus: NarrationPlan['policyStatus'] = context.policyStatus;
  let shadowPrepared: string | undefined;

  if (scientific) {
    // Production: proposed (unapproved) dictionary entries are never spoken.
    const production = loadPolicyPack(context.language, { allowProposed: input.allowProposed === true });
    const gated = input.allowProposed !== true && production.status !== 'approved' && !config.allowExperimental;
    if (gated) {
      // O-4 readiness gate: the unapproved policy never reaches learners. The
      // narration is sent as authored (D-10: the narration AI already writes
      // formulas in words), with the governed profile.
      warnings = [makeWarning('SATTS_W_POLICY_NOT_APPROVED', 0, text.length, production.policyVersion)];
      policyVersion = production.policyVersion;
      policyStatus = production.status;
    } else {
      const experimental = production.status !== 'approved' && input.allowProposed !== true;
      if (experimental) {
        log.warn(`SATTS_ALLOW_EXPERIMENTAL: speaking proposed wording (${production.policyVersion}, experimental)`);
      }
      const policy = experimental ? loadPolicyPack(context.language, { allowProposed: true }) : production;
      const rendered = renderScientificSpeech({ context }, policy);
      sentText = rendered.preparedText;
      spans = rendered.spans;
      warnings = rendered.warnings;
      policyVersion = rendered.policyVersion;
      policyStatus = policy.status;
      if (rendered.blocking) blocking = { code: rendered.blocking.code, message: rendered.blocking.message };
    }
  } else if (config.mode === 'shadow' && context.subjectCode !== null) {
    // Shadow: render and report, but send the original with today's profile.
    const rendered = renderScientificSpeech(
      { context },
      loadPolicyPack(context.language, { allowProposed: true }),
    );
    warnings = rendered.warnings;
    shadowPrepared = rendered.preparedText;
  }

  // Segmentation applies only when the scientific flag is on and the provider
  // has a capability row; the general path keeps today's single request.
  let segments: PreparedSegment[] = [{ text: sentText, start: 0, end: sentText.length }];
  const capability = profile.capability;
  if (!blocking && config.mode === 'on' && capability) {
    const instructionsTokens = profile.instructions ? countTokens(profile.instructions) : 0;
    const result = segmentPrepared(
      sentText,
      spans,
      {
        maxChars: Math.min(capability.maxReliableSegmentChars, capability.maxInputChars),
        maxTokens: capability.maxReliableSegmentTokens,
        kappa: capability.tokenKappa,
        instructionsTokens,
        hardTokenCap: capability.maxInputTokens !== undefined ? capability.maxInputTokens - TOKEN_CAP_MARGIN : undefined,
      },
      countTokens,
    );
    if (result.ok) segments = result.segments;
    else blocking = { code: result.code, message: `an atomic expression exceeds the segment budget at ${result.at}` };
  }

  const subjectCode = scientific ? context.subjectCode : null;
  const responseFormat = profile.responseFormat ?? 'default';
  const delivery = deliveryDigest(profile.instructions);
  const preparedDigest = sha256Hex(sentText);
  const fingerprint = computeFingerprint({
    originalText: text,
    preparedDigest,
    subjectCode,
    language: context.language,
    readingMode: context.readingMode,
    providerId: profile.providerId,
    modelId: profile.modelId,
    voice: profile.voice,
    speed: profile.speed,
    responseFormat,
    deliveryDigest: delivery,
  });
  return {
    path: scientific ? 'scientific' : 'general',
    sentText,
    segments,
    spans,
    warnings,
    blocking,
    policyVersion,
    policyStatus,
    subjectCode,
    stageSubjectCode: input.stageSubjectCode,
    language: context.language,
    readingMode: context.readingMode,
    fingerprint,
    originalDigest: sha256Hex(text),
    preparedDigest,
    deliveryDigest: delivery,
    responseFormat,
    ...(shadowPrepared !== undefined ? { shadowPrepared } : {}),
  };
}

export type AssessStatus = 'current' | 'stale' | 'legacy' | 'missing';

export interface NarrationAssessment {
  status: AssessStatus;
  expectedFingerprint: string;
  reason?: StaleReason;
}

/** Plan §13.4. With the flag `off`, scientific provenance counts as current (rollback, §18.3). */
export function assessNarrationAudio(
  action: Pick<SpeechAction, 'audioId' | 'audioInvalidated' | 'audioProvenance'>,
  plan: NarrationPlan,
  profile: Pick<SpeechProfile, 'providerId' | 'modelId' | 'voice' | 'speed'>,
  mode: SpeechConfig['mode'],
): NarrationAssessment {
  const expectedFingerprint = plan.fingerprint;
  if (!action.audioId || action.audioInvalidated) return { status: 'missing', expectedFingerprint };
  const provenance = sanitizeAudioProvenance(action.audioProvenance);
  if (!provenance) return { status: 'legacy', expectedFingerprint };
  if (mode === 'off' && provenance.policyVersion !== null) return { status: 'current', expectedFingerprint };
  if (provenance.fingerprint === expectedFingerprint) {
    if (provenance.policyStatus === 'experimental' && plan.path === 'scientific' && plan.policyStatus === 'approved') {
      return { status: 'stale', expectedFingerprint, reason: 'experimental' };
    }
    return { status: 'current', expectedFingerprint };
  }
  const checks: Array<[StaleReason, boolean]> = [
    ['text', provenance.originalDigest !== plan.originalDigest],
    ['prepared', provenance.preparedDigest !== plan.preparedDigest],
    ['subject', (provenance.subjectCode ?? null) !== plan.subjectCode],
    ['language', (provenance.language ?? null) !== plan.language],
    ['mode', (provenance.readingMode ?? 'natural') !== plan.readingMode],
    ['provider', provenance.providerId !== profile.providerId],
    ['voice', provenance.voice !== profile.voice],
    ['model', provenance.modelId !== profile.modelId],
    ['speed', provenance.speed !== profile.speed],
    ['format', provenance.responseFormat !== plan.responseFormat],
    ['delivery', (provenance.deliveryDigest ?? null) !== plan.deliveryDigest],
  ];
  const reason = checks.find(([, differs]) => differs)?.[0] ?? 'prepared';
  return { status: 'stale', expectedFingerprint, reason };
}

export type NarrationPersistTarget =
  | { kind: 'none' }
  /** Batch: `CLASSROOMS_DIR/<stage>/audio/tts-<id>-<fp12>.<ext>` (B-4). */
  | { kind: 'audio-dir'; rootDir?: string }
  /** Agent runtime: the existing content-hashed `media/` path. */
  | { kind: 'media' };

export interface SynthesisRequest {
  action: SpeechAction;
  stageId: string | null;
  plan: NarrationPlan;
  profile: SpeechProfile;
  config: SpeechConfig;
  reason: SynthesisReason;
  entry: NarrationEntry;
  persist: NarrationPersistTarget;
  /** Record usage per provider call (B-3 batch; route always; agent only when not `off`). */
  recordUsage: boolean;
  /** Total attempts for transient provider errors (429/5xx/timeout). 1 = no retry. */
  transientAttempts?: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to a jittered real delay. */
  sleep?: (ms: number) => Promise<void>;
  /** The Teaching Engine route applied (`prepareNarration().route`), logged with the outcome. */
  routeId?: string | null;
}

export interface SynthesisOutcome {
  outcome: 'generated' | 'regenerated' | 'failed';
  reason: SynthesisReason;
  path: 'general' | 'scientific';
  audio?: { bytes: Uint8Array; format: string; durationSeconds: number | null };
  /** Persisted reference (relative serving path). */
  audioRef?: string;
  provenance?: SpeechAudioProvenance;
  warnings: RenderWarning[];
  error?: { code: NarrationErrorCode; message: string };
  usage: { segments: number; preparedChars: number; inputTokens?: number; outputTokens?: number };
}

function isTransient(error: unknown): boolean {
  if (error instanceof TTSRateLimitError || error instanceof TTSRequestTimeoutError) return true;
  if (error instanceof TTSInvalidResponseError) return error.httpStatus >= 500;
  return error instanceof Error && /\b5\d\d\b/.test(error.message);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Letters and digits spoken; the plausibility floor is `letters / 16` seconds (Wave 0 §3). */
function spokenLetters(text: string): number {
  let count = 0;
  for (const ch of text) if (/[\p{L}\p{N}]/u.test(ch)) count += 1;
  return count;
}

function outcomeEvent(
  req: SynthesisRequest,
  outcome: SynthesisOutcome,
  startedAt: number,
): void {
  log.info(
    'speech.narration.outcome',
    JSON.stringify({
      outcome: outcome.outcome,
      reason: req.reason,
      path: outcome.path,
      entry: req.entry,
      stageId: req.stageId,
      actionId: req.action.id,
      fingerprintPrefix: fingerprintPrefix(req.plan.fingerprint),
      subjectCode: req.plan.subjectCode,
      language: req.plan.language,
      policyVersion: req.plan.policyVersion,
      policyStatus: req.plan.policyStatus,
      providerId: req.profile.providerId,
      modelId: req.profile.modelId,
      voice: req.profile.voice,
      ...(req.routeId ? { routeId: req.routeId } : {}),
      segments: outcome.usage.segments,
      originalChars: req.action.text.length,
      preparedChars: outcome.usage.preparedChars,
      instructionsChars: req.profile.instructions?.length ?? 0,
      warningCodes: outcome.warnings.map((w) => w.code),
      errorCode: outcome.error?.code,
      durationMs: Date.now() - startedAt,
      audioSeconds: outcome.audio?.durationSeconds ?? undefined,
    }),
  );
}

export async function synthesizeNarration(req: SynthesisRequest): Promise<SynthesisOutcome> {
  const startedAt = Date.now();
  const { plan, profile } = req;
  const base = { reason: req.reason, path: plan.path, warnings: plan.warnings };
  const fail = (code: NarrationErrorCode, message: string): SynthesisOutcome => {
    const outcome: SynthesisOutcome = {
      ...base,
      outcome: 'failed',
      error: { code, message },
      usage: { segments: 0, preparedChars: 0 },
    };
    outcomeEvent(req, outcome, startedAt);
    return outcome;
  };
  if (plan.blocking) return fail(plan.blocking.code, plan.blocking.message);

  const sleep = req.sleep ?? defaultSleep;
  const attempts = Math.max(1, req.transientAttempts ?? 1);
  const governedStream = profile.governed && profile.capability?.usageSource === 'sse-done';
  const config: TTSModelConfig = {
    providerId: profile.providerId as TTSProviderId,
    modelId: profile.governed ? profile.modelId : 'requestModelId' in profile ? profile.requestModelId : profile.modelId,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    voice: profile.voice,
    speed: profile.governed ? profile.speed : 'requestSpeed' in profile ? profile.requestSpeed : profile.speed,
    ...(profile.providerOptions ? { providerOptions: profile.providerOptions } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    ...(profile.governed
      ? {
          ...(profile.instructions ? { instructions: profile.instructions } : {}),
          ...(profile.responseFormat ? { responseFormat: profile.responseFormat } : {}),
          ...(governedStream ? { streamFormat: 'sse' as const } : {}),
          requestTimeoutMs: profile.capability?.requestTimeoutMs,
          ...(profile.capability?.localeParam === 'language' && req.config.arLocale
            ? { language: req.config.arLocale }
            : {}),
        }
      : // A routed profile carries its Stage language (Cartesia needs it in every mode).
        profile.locale
        ? { language: profile.locale }
        : {}),
  };

  const parts: Uint8Array[] = [];
  let format: string = profile.responseFormat ?? 'mp3';
  let inputTokens = 0;
  let outputTokens = 0;
  let exactUsage = governedStream;
  let preparedChars = 0;

  for (const segment of plan.segments) {
    let completionRetry = true;
    let transientLeft = attempts - 1;
    for (;;) {
      try {
        const result = await generateTTS(config, segment.text);
        format = result.format || format;
        if (governedStream && result.completed === false) {
          throw new NarrationSynthesisError('SATTS_E_PROVIDER_INCOMPLETE', 'stream ended without speech.audio.done');
        }
        if (profile.governed) {
          const { durationSeconds } = joinAudio([result.audio], format);
          if (durationSeconds !== null && durationSeconds < spokenLetters(segment.text) / 16) {
            throw new NarrationSynthesisError(
              'SATTS_E_PROVIDER_TRUNCATED',
              `audio ${durationSeconds.toFixed(1)}s is implausibly short for the segment`,
            );
          }
        }
        parts.push(result.audio);
        preparedChars += segment.text.length;
        if (result.usage) {
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
        } else exactUsage = false;
        if (req.recordUsage) {
          void recordGenerationUsage({
            kind: 'tts',
            unit: 'character',
            providerId: profile.providerId,
            modelId: config.modelId,
            quantity: segment.text.length,
            ...(req.config.mode !== 'off'
              ? {
                  meta: {
                    entry: req.entry,
                    originalChars: req.action.text.length,
                    instructionsChars: profile.instructions?.length ?? 0,
                    ...(result.usage
                      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, estimated: false }
                      : {
                          estInputTokens:
                            countTokens(segment.text) + (profile.instructions ? countTokens(profile.instructions) : 0),
                          estimated: true,
                        }),
                    subjectCode: plan.subjectCode,
                    fingerprintPrefix: fingerprintPrefix(plan.fingerprint),
                  },
                }
              : {}),
          });
        }
        break;
      } catch (error) {
        if (req.signal?.aborted) throw error;
        if (error instanceof NarrationSynthesisError && completionRetry) {
          completionRetry = false;
          continue;
        }
        if (error instanceof NarrationSynthesisError) return fail(error.code, error.message);
        if (transientLeft > 0 && isTransient(error)) {
          transientLeft -= 1;
          await sleep(500 * (attempts - transientLeft) + Math.floor(Math.random() * 250));
          continue;
        }
        // Timeouts keep propagating as before (agent runtime relies on it).
        if (error instanceof TTSRequestTimeoutError && req.entry === 'agent') throw error;
        // All-or-nothing: no asset is written for a partially synthesised Action.
        if (req.entry === 'route' || req.entry === 'dynamic' || req.entry === 'preview') throw error;
        return fail('SATTS_E_PROVIDER_FAILED', error instanceof Error ? error.message : String(error));
      }
    }
  }

  let joined: { bytes: Uint8Array; durationSeconds: number | null };
  try {
    joined = joinAudio(parts, format);
  } catch (error) {
    if (error instanceof AudioConcatError) return fail('SATTS_E_JOIN_FAILED', error.message);
    throw error;
  }

  const provenance: SpeechAudioProvenance = {
    fingerprint: plan.fingerprint,
    policyVersion: plan.policyVersion,
    ...(plan.path === 'scientific' ? { policyStatus: plan.policyStatus } : {}),
    originalDigest: plan.originalDigest,
    responseFormat: plan.responseFormat,
    deliveryDigest: plan.deliveryDigest,
    subjectCode: plan.subjectCode,
    stageSubjectCode: plan.stageSubjectCode,
    language: plan.language,
    readingMode: plan.readingMode,
    providerId: profile.providerId,
    modelId: profile.modelId,
    voice: profile.voice,
    speed: profile.speed,
    deliveryProfile: profile.deliveryProfile,
    preparedDigest: plan.preparedDigest,
    segments: plan.segments.length,
    preparedChars,
    originalChars: req.action.text.length,
    warningCount: plan.warnings.length,
    generatedAt: new Date().toISOString(),
    reason:
      req.reason === 'dynamic' || req.reason === 'preview' || req.reason === 'initial' ? 'initial' : req.reason,
  };

  let audioRef: string | undefined;
  if (req.persist.kind === 'audio-dir' && req.stageId) {
    audioRef = (
      await writeNarrationAudio({
        stageId: req.stageId,
        actionId: req.action.id,
        fingerprint: plan.fingerprint,
        format,
        bytes: joined.bytes,
        rootDir: req.persist.rootDir,
      })
    ).relativeUrl;
  } else if (req.persist.kind === 'media' && req.stageId) {
    audioRef = await persistClassroomMediaBytes({
      stageId: req.stageId,
      bytes: Buffer.from(joined.bytes),
      mime: format === 'wav' ? 'audio/wav' : format === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
      // Off keeps today's name; otherwise the fingerprint prefix makes it content-addressed by inputs too.
      prefix:
        req.config.mode === 'off'
          ? `tts-${req.action.id}`
          : `tts-${req.action.id}-${fingerprintPrefix(plan.fingerprint)}`,
      signal: req.signal,
    });
  }

  const outcome: SynthesisOutcome = {
    ...base,
    outcome: req.action.audioId ? 'regenerated' : 'generated',
    audio: { bytes: joined.bytes, format, durationSeconds: joined.durationSeconds },
    ...(audioRef ? { audioRef } : {}),
    provenance,
    usage: {
      segments: plan.segments.length,
      preparedChars,
      ...(exactUsage ? { inputTokens, outputTokens } : {}),
    },
  };
  outcomeEvent(req, outcome, startedAt);
  return outcome;
}

/** A reuse outcome event (no provider call) — FR-037. */
export function recordReuse(
  entry: NarrationEntry,
  action: Pick<SpeechAction, 'id'>,
  plan: NarrationPlan,
  status: AssessStatus,
): void {
  log.info(
    'speech.narration.outcome',
    JSON.stringify({
      outcome: status === 'legacy' ? 'skipped' : 'reused',
      entry,
      actionId: action.id,
      path: plan.path,
      fingerprintPrefix: fingerprintPrefix(plan.fingerprint),
      subjectCode: plan.subjectCode,
      policyVersion: plan.policyVersion,
      assess: status,
    }),
  );
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

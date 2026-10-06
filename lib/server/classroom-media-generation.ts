/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import { readSpeechConfig } from '@/lib/server/speech/config';
import {
  assessNarrationAudio,
  loggableErrorMessage,
  recordReuse,
  synthesizeNarration,
} from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import { providerCapability } from '@/lib/server/speech/provider-capabilities';
import {
  routedProviderStatus,
  routedProviderUnavailableMessage,
  teachingRouteForStage,
} from '@/lib/server/speech/teaching-route';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { resolveImageSize } from '@/lib/server/image-sizing';
import { screenVisualWithDefaults, type ImageTextPolicy } from '@/lib/server/visual-compliance';
import { applyImagePromptPolicy } from '@/lib/server/visual-compliance/prompt-policy';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import {
  createConcurrencyLimiter,
  createStartSpacer,
  mapWithConcurrency,
} from '@/lib/utils/concurrency';

const log = createLogger('ClassroomMedia');

/**
 * The classroom JSON payload is a pre-conversion transport, not a persisted
 * DSL document. `audioUrl` is gone from the `SpeechAction` contract, but the
 * file-based classroom store has no asset registry to allocate from, so the
 * server still hands the client the serving URL beside the derived `audioId`.
 * The app-side reference converter ingests the URL's bytes and rewrites the
 * pair to one allocated asset id when the classroom is first fetched, before
 * the document is persisted client-side; the URL never enters a stored
 * document.
 */
type ServerTransportSpeechAction = SpeechAction & { audioUrl?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(baseUrl: string, classroomId: string, subPath: string): string {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

/** Regenerations with a reinforced prompt after a non-approved attempt. */
const MAX_COMPLIANCE_REGENERATIONS = 2;

export interface ClassroomMediaOptions {
  /** Embedded-text policy resolved from the Stage's authoritative direction. */
  textPolicy?: ImageTextPolicy;
  /**
   * Governed Teaching Packages never use a video that could not be screened
   * (frame extraction is not available in this runtime → `unresolved`).
   */
  withholdUnscreenedVideo?: boolean;
  /** Test seam; defaults to the deployment's store + vision client. */
  screen?: typeof screenVisualWithDefaults;
}

/**
 * Generate → screen → approve or reject. Only an `approved` visual is written
 * to stage media and mapped; a rejected / unresolved one is never written, and
 * its placeholder stays unmapped so assembly drops the element.
 */
export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  options: ClassroomMediaOptions = {},
): Promise<Record<string, string>> {
  const screen = options.screen ?? screenVisualWithDefaults;
  const textPolicy = options.textPolicy ?? 'unrestricted';
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers, excluding operator force-disabled ones (server
  // precedence, #665 — mirror the TTS listing's disabled flag).
  const imageProviderIds = Object.entries(getServerImageProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);
  const videoProviderIds = Object.entries(getServerVideoProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => r.type === 'video' && videoProviderIds.length > 0);

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // No client model here — the server-side `IMAGE_<PREFIX>_MODELS` pin
        // (first entry) is authoritative when set; otherwise fall back to the
        // first catalog model so key-only deployments keep generating. This
        // path is internal (no HTTP response to fail loud with), so the
        // adapter's requireModel must stay a backstop, never the primary
        // failure mode.
        const model = resolveImageModel(providerId) ?? providerConfig?.models?.[0]?.id;

        let approved: { buf: Buffer; ext: string } | undefined;
        for (let attempt = 0; attempt <= MAX_COMPLIANCE_REGENERATIONS && !approved; attempt += 1) {
          const result = await generateImage(
            { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
            resolveImageSize(
              applyImagePromptPolicy(
                { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
                textPolicy,
                attempt > 0,
              ),
              { providerId, modelId: model },
            ),
          );

          let buf: Buffer;
          let ext: string;
          if (result.base64) {
            buf = Buffer.from(result.base64, 'base64');
            ext = 'png';
          } else if (result.url) {
            buf = await downloadToBuffer(result.url);
            const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
            ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
          } else {
            log.warn(`Image generation returned no data for ${req.elementId}`);
            break;
          }

          const verdict = await screen(buf, {
            origin: 'generated',
            textPolicy,
            mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            metadata: { description: req.prompt },
          });
          if (verdict.verdict === 'approved') approved = { buf, ext };
          else
            log.warn(
              `Generated image ${req.elementId} attempt ${attempt + 1} not approved (${verdict.verdict}); bytes discarded`,
            );
        }
        if (!approved) {
          log.warn(`No approved image for ${req.elementId}; its placeholder stays unmapped`);
          continue;
        }

        const filename = `${req.elementId}.${approved.ext}`;
        await fs.writeFile(path.join(mediaDir, filename), approved.buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated image: ${filename}`);
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        const providerId = videoProviderIds[0] as VideoProviderId;
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // No client model here — the server-side `VIDEO_<PREFIX>_MODELS` pin
        // (first entry) is authoritative when set; otherwise fall back to the
        // first catalog model so key-only deployments keep generating. This
        // path is internal (no HTTP response to fail loud with), so the
        // adapter's requireModel must stay a backstop, never the primary
        // failure mode.
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = resolveVideoModel(providerId) ?? providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          normalized,
        );

        if (options.withholdUnscreenedVideo) {
          // Frame extraction is unavailable here, so the video cannot be
          // screened: `unresolved` → withheld from a governed package.
          log.warn(`Generated video ${req.elementId} withheld: video frames cannot be screened`);
          continue;
        }
        const buf = await downloadToBuffer(result.url);
        const filename = `${req.elementId}.mp4`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated video: ${filename}`);
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || /^gen_vid_[\w-]+$/i.test(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isGeneratedMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

/** Per-run narration summary (plan §16.1): counts by outcome, subject and warning code. */
export interface ClassroomTtsSummary {
  generated: number;
  reused: number;
  skipped: number;
  failed: number;
  bySubject: Record<string, number>;
  warningCodes: Record<string, number>;
}

/** Stage fields the narration context reads (plan §8.1). */
export type ClassroomTtsStage = Pick<Stage, 'subjectCode' | 'language' | 'speechReadingMode'>;

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  options: { stage?: ClassroomTtsStage | null } = {},
): Promise<ClassroomTtsSummary | void> {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Teaching Engine TTS route (from the Stage's language and subject): when it
  // matches, its provider/model/voice are authoritative and an unavailable
  // routed provider skips TTS — never the first configured provider instead.
  const route = teachingRouteForStage(options.stage);
  let providerId: TTSProviderId;
  let modelId: string;
  let voice: string;
  let apiKey: string | undefined;
  let ttsBaseUrl: string | undefined;
  if (route) {
    const status = routedProviderStatus(route.providerId);
    if (status.status !== 'ok') {
      log.warn(`${routedProviderUnavailableMessage(route, status.status)}; skipping TTS generation`);
      return;
    }
    providerId = route.providerId;
    modelId = route.modelId;
    voice = route.voiceId;
    apiKey = status.apiKey;
    ttsBaseUrl = status.baseUrl;
  } else {
    // Resolve TTS provider (exclude browser-native-tts and operator force-disabled
    // providers — server precedence, #665).
    const ttsProviderIds = Object.entries(getServerTTSProviders())
      .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
      .map(([id]) => id);
    if (ttsProviderIds.length === 0) {
      log.warn('No server TTS provider configured, skipping TTS generation');
      return;
    }

    providerId = ttsProviderIds[0] as TTSProviderId;
    apiKey = resolveTTSApiKey(providerId);
    const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
    if (ttsProvider?.requiresApiKey && !apiKey) {
      log.warn(`No API key for TTS provider "${providerId}", skipping TTS generation`);
      return;
    }
    ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
    voice = DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
    if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID) {
      log.warn('VoxCPM Auto Voice requires agent context; skipping server-side TTS generation');
      return;
    }
    // B-1 (approved): operator model pins apply to the batch path too.
    modelId =
      resolveTTSModel(
        providerId,
        DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
        voice,
      ) || '';
  }
  const speechConfig = readSpeechConfig();
  const summary: ClassroomTtsSummary = {
    generated: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    bySubject: {},
    warningCodes: {},
  };
  // One asset per Action on the scientific path: no Action splitting there (§13.2).
  const segmentsInOrchestrator =
    speechConfig.mode === 'on' && providerCapability(providerId, modelId) !== null;

  // Every scene is split first, so the pool below sees every speech Action of
  // the package at once; a per-scene pool would still wait at each scene.
  const jobs: Array<{ speechAction: ServerTransportSpeechAction; audioId: string }> = [];
  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Split long speech actions into multiple shorter ones before TTS generation,
    // mirroring the client-side approach. Each sub-action gets its own audio file.
    if (!segmentsInOrchestrator) scene.actions = splitLongSpeechActions(scene.actions, providerId);

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      // Server transport emits the derived id plus the serving URL; the
      // client-side converter collapses the pair into one pool asset on
      // first load. Browser generation allocates pool ids directly.
      // B-4: the derived transport id keeps its shape; the FILE is content-addressed.
      jobs.push({
        speechAction: action as ServerTransportSpeechAction,
        audioId: `tts_s${sceneOrder}_${action.id}`,
      });
    }
  }

  // At most TTS_AR_CONCURRENCY (default 6) Actions synthesise at once (SATTS
  // plan §13.2), and two syntheses start at least TTS_BATCH_START_GAP_MS
  // (default 1 s) apart. Each Action keeps its own try/catch, so one failure
  // never sinks the batch; audio files are per-Action and written temp-then-rename.
  const spacer = createStartSpacer(speechConfig.batchStartGapMs);
  // A provider with a plan concurrency limit (Cartesia Free: 2) gets its own tighter
  // cap, keyed by the provider each Action actually synthesises with.
  const providerLimiters = new Map<string, ReturnType<typeof createConcurrencyLimiter>>();
  const providerLimiter = (id: string) => {
    const cap = speechConfig.providerBatchConcurrency[id];
    if (!cap) return null;
    let limiter = providerLimiters.get(id);
    if (!limiter) providerLimiters.set(id, (limiter = createConcurrencyLimiter(cap)));
    return limiter;
  };
  await mapWithConcurrency(jobs, speechConfig.arConcurrency, async ({ speechAction, audioId }) => {
    try {
      const { plan, profile } = await prepareNarration({
        text: speechAction.text,
        stage: options.stage ?? null,
        stageId: classroomId,
        config: speechConfig,
        fallback: {
          providerId,
          modelId,
          apiKey,
          baseUrl: ttsBaseUrl,
          voice,
          speed: speechAction.speed ?? 1,
          requestSpeed: speechAction.speed,
        },
        actionSpeed: speechAction.speed,
      });
      // Skip-if-current (§13.5) only when the scientific flag is not off (DEC-002).
      if (speechConfig.mode !== 'off') {
        const assessment = assessNarrationAudio(speechAction, plan, profile, speechConfig.mode);
        if (assessment.status === 'current' || assessment.status === 'legacy') {
          recordReuse('batch', speechAction, plan, assessment.status);
          if (assessment.status === 'current') summary.reused += 1;
          else summary.skipped += 1;
          return;
        }
      }
      // Only real syntheses take a start slot; reused audio never waits. The start
      // gap is taken inside the provider cap, right before the request goes out.
      const synthesize = async () => {
        await spacer.wait();
        return synthesizeNarration({
          action: speechAction,
          stageId: classroomId,
          plan,
          profile,
          config: speechConfig,
          reason: speechAction.audioId ? 'stale' : 'initial',
          entry: 'batch',
          persist: { kind: 'audio-dir' },
          // B-3 (approved): the batch path records usage.
          recordUsage: true,
          // B-2 (approved): bounded retry for 429/5xx/timeout.
          transientAttempts: 2,
          routeId: route?.routeId,
        });
      };
      const limiter = providerLimiter(profile.providerId);
      const outcome = await (limiter ? limiter.run(synthesize) : synthesize());
      for (const warning of outcome.warnings) {
        summary.warningCodes[warning.code] = (summary.warningCodes[warning.code] ?? 0) + 1;
      }
      if (outcome.outcome === 'failed' || !outcome.audioRef) {
        summary.failed += 1;
        log.warn(
          `TTS generation failed for action ${speechAction.id}: ${outcome.error?.code ?? 'unknown'}${
            outcome.error ? ` (${loggableErrorMessage(outcome.error.message)})` : ''
          }`,
        );
        return;
      }
      summary.generated += 1;
      const subjectKey = plan.subjectCode ?? 'general';
      summary.bySubject[subjectKey] = (summary.bySubject[subjectKey] ?? 0) + 1;
      const subPath = outcome.audioRef.split(`/api/classroom-media/${classroomId}/`)[1]!;
      speechAction.audioId = audioId;
      speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, subPath);
      speechAction.audioProvenance = outcome.provenance;
      log.info(`Generated TTS: ${subPath} (${outcome.audio?.bytes.length ?? 0} bytes)`);
    } catch (err) {
      summary.failed += 1;
      log.warn(`TTS generation failed for action ${speechAction.id}:`, err);
    }
  });
  return summary;
}

/**
 * Drop image / video elements whose generated-media placeholder never received
 * an approved mapping (generation failed, or every attempt was rejected /
 * unresolved). An unmapped placeholder must never survive into a persisted
 * Stage — it would render as a permanent skeleton. Returns the removed
 * placeholder ids per scene id.
 */
export function dropUnmappedMediaPlaceholders(scenes: Scene[]): Map<string, string[]> {
  const removed = new Map<string, string[]>();
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;
    const dropped: string[] = [];
    canvas.elements = canvas.elements.filter((el) => {
      if (el.type !== 'image' && el.type !== 'video') return true;
      const pending =
        (typeof el.src === 'string' && isGeneratedMediaPlaceholder(el.src)) ||
        (el.type === 'video' && !el.src && typeof el.mediaRef === 'string');
      if (pending) dropped.push(el.src || el.mediaRef || el.id);
      return !pending;
    });
    if (dropped.length > 0) removed.set(scene.id, dropped);
  }
  return removed;
}

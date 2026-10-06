/**
 * Single TTS Generation API
 *
 * Generates TTS audio for a single text string and returns base64-encoded audio.
 * Called by the client in parallel for each speech action after a scene is generated.
 *
 * POST /api/generate/tts
 */

import { NextRequest } from 'next/server';
import { QwenTTSError, TTSInvalidResponseError, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { readSpeechConfig } from '@/lib/server/speech/config';
import { synthesizeNarration } from '@/lib/server/speech/narration-synthesis';
import { prepareNarration, routedFallbackProfile } from '@/lib/server/speech/prepare';
import { governedSubjectFromStore, SpeechContextUnavailableError } from '@/lib/server/speech/speech-context';
import type { FallbackProfile } from '@/lib/server/speech/speech-profile';
import { loadStageForSpeech } from '@/lib/server/speech/stage-access';
import {
  routedProviderStatus,
  routedProviderUnavailableMessage,
  teachingRouteForStage,
} from '@/lib/server/speech/teaching-route';
import type { SpeechAction } from '@/lib/types/action';
import {
  isServerConfiguredProvider,
  isServerTTSProviderDisabled,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
  TTSModelNotAllowedError,
} from '@/lib/server/provider-config';
import type { TTSProviderId } from '@/lib/audio/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import { isQwenCloneVoice } from '@/lib/audio/constants';

const log = createLogger('TTS API');

// B-6 (approved): room for multi-segment Actions at the governed 90 s per-call timeout.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  let ttsProviderId: string | undefined;
  let ttsVoice: string | undefined;
  let audioId: string | undefined;
  try {
    const body = await req.json();
    const { text, ttsModelId, ttsSpeed, ttsApiKey, ttsBaseUrl, ttsProviderOptions } = body as {
      text: string;
      /** SATTS: the Stage whose authoritative context applies (never trusted for the context itself). */
      stageId?: string;
      actionId?: string;
      /** SATTS: runtime (discussion) speech — subject-aware, never persisted. */
      dynamic?: boolean;
      reason?: 'initial' | 'manual' | 'stale' | 'repair' | 'policy';
      audioId: string;
      ttsProviderId: TTSProviderId;
      ttsModelId?: string;
      ttsVoice: string;
      ttsSpeed?: number;
      ttsApiKey?: string;
      ttsBaseUrl?: string;
      ttsProviderOptions?: Record<string, unknown>;
    };
    ttsProviderId = body.ttsProviderId;
    ttsVoice = typeof body.ttsVoice === 'string' ? body.ttsVoice.trim() : undefined;
    audioId = body.audioId;

    // Validate required fields
    if (!text || !audioId || !ttsProviderId || !ttsVoice) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Missing required fields: text, audioId, ttsProviderId, ttsVoice',
      );
    }

    // Reject browser-native TTS — must be handled client-side
    if (ttsProviderId === 'browser-native-tts') {
      return apiError('INVALID_REQUEST', 400, 'browser-native-tts must be handled client-side');
    }

    // Teaching Engine context (SATTS plan §7.2, TTS routing): language and
    // subject come from the persisted Stage — for a caller authorised for it —
    // never from this body. The Stage is read whenever a stageId is sent, in
    // every SCIENTIFIC_TTS_MODE, because the provider route depends on it; and
    // it is read BEFORE provider validation so the routed provider is the one
    // validated, keyed and executed.
    const speechConfig = readSpeechConfig();
    const stageId = typeof body.stageId === 'string' && body.stageId ? body.stageId : null;
    const dynamic = body.dynamic === true;
    let stageAccess: Awaited<ReturnType<typeof loadStageForSpeech>> = null;
    if (stageId) {
      try {
        stageAccess = await loadStageForSpeech(req, stageId, dynamic ? 'read' : 'write');
      } catch (error) {
        // Persisted generation fails closed on a known Stage (§14.2): it can be
        // neither routed nor rendered. Dynamic speech falls back to general.
        if (!dynamic && error instanceof SpeechContextUnavailableError) {
          return apiError(error.code, 503, error.message);
        }
        stageAccess = null;
      }
    }
    const route = teachingRouteForStage(stageAccess?.stage);
    const requestedSpeed = ttsSpeed ?? 1.0;

    let fallback: FallbackProfile;
    let registeredVoiceLog = 'none';
    if (route) {
      // A matched route is authoritative: the client's provider, model, voice,
      // key, base URL and provider options are not used, and an unavailable
      // routed provider is reported — never replaced by another one.
      const status = routedProviderStatus(route.providerId);
      if (status.status !== 'ok') {
        const message = routedProviderUnavailableMessage(route, status.status);
        log.warn(`${message} [audioId=${audioId}]`);
        return status.status === 'disabled'
          ? apiError('PROVIDER_DISABLED', 403, message)
          : apiError('MISSING_API_KEY', 400, message);
      }
      ttsProviderId = route.providerId;
      ttsVoice = route.voiceId;
      fallback = routedFallbackProfile(route, { speed: requestedSpeed });
    } else {
      // Enforce server precedence: a force-disabled provider is off for everyone,
      // regardless of any client key/selection (#665).
      if (isServerTTSProviderDisabled(ttsProviderId)) {
        return apiError('PROVIDER_DISABLED', 403, 'This TTS provider is disabled by the server');
      }

      const voxcpmVoicePrompt =
        typeof ttsProviderOptions?.voicePrompt === 'string' ? ttsProviderOptions.voicePrompt : '';
      const voxcpmRegisteredVoiceId =
        typeof ttsProviderOptions?.registeredVoiceId === 'string'
          ? ttsProviderOptions.registeredVoiceId
          : '';
      registeredVoiceLog = voxcpmRegisteredVoiceId || 'none';
      if (
        ttsProviderId === VOXCPM_TTS_PROVIDER_ID &&
        ttsVoice === VOXCPM_AUTO_VOICE_ID &&
        !voxcpmVoicePrompt.trim() &&
        !voxcpmRegisteredVoiceId.trim()
      ) {
        return apiError(
          'VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT',
          400,
          'VoxCPM Auto Voice requires agent context',
        );
      }

      // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
      const managed = isServerConfiguredProvider('tts', ttsProviderId);
      const clientBaseUrl = managed ? undefined : ttsBaseUrl || undefined;
      if (clientBaseUrl) {
        const ssrfError = await validateUrlForSSRF(clientBaseUrl);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }

      const apiKey = resolveTTSApiKey(ttsProviderId, managed ? undefined : ttsApiKey || undefined);
      const baseUrl = resolveTTSBaseUrl(ttsProviderId, clientBaseUrl);

      // Pre-flight the same key requirement the library enforces: a keyed provider
      // with no key (server config AND client-supplied key both absent) is a
      // client contract violation, not a server failure. Return the image route's
      // MISSING_API_KEY envelope instead of falling through to a 500
      // GENERATION_FAILED. Unknown/custom providers keep their existing behavior.
      const ttsProvider = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS];
      if (ttsProvider?.requiresApiKey && !apiKey) {
        return apiError(
          'MISSING_API_KEY',
          400,
          `No API key configured for TTS provider: ${ttsProviderId}`,
        );
      }

      // Build TTS config (managed providers may pin the model server-side)
      const qwenCloneVoice = ttsProviderId === 'qwen-tts' && isQwenCloneVoice(ttsVoice);
      const resolvedModelId = resolveTTSModel(ttsProviderId, ttsModelId, ttsVoice);
      fallback = {
        providerId: ttsProviderId as TTSProviderId,
        modelId: resolvedModelId ?? '',
        requestModelId: resolvedModelId,
        voice: ttsVoice,
        speed: qwenCloneVoice ? 1 : requestedSpeed,
        apiKey,
        baseUrl,
        providerOptions: {
          ...(ttsProviderOptions || {}),
          ...(qwenCloneVoice ? { qwenVoiceClone: true } : {}),
        },
      };
    }

    log.info(
      `Generating TTS: provider=${fallback.providerId}, model=${fallback.requestModelId || 'default'}, voice=${fallback.voice}, ` +
        `route=${route?.routeId ?? 'none'}, registeredVoiceId=${registeredVoiceLog}, audioId=${audioId}, textLen=${text.length}`,
    );

    const speechAction = {
      id: typeof body.actionId === 'string' && body.actionId ? body.actionId : audioId,
      type: 'speech',
      text,
    } as SpeechAction;
    let prepared;
    try {
      prepared = await prepareNarration({
        text,
        stage: stageAccess?.stage ?? null,
        stageId: stageAccess ? stageId : null,
        config: speechConfig,
        fallback,
        governedSubjectLookup: governedSubjectFromStore,
      });
    } catch (error) {
      if (!dynamic && error instanceof SpeechContextUnavailableError) {
        return apiError(error.code, 503, error.message);
      }
      throw error;
    }

    const outcome = await synthesizeNarration({
      action: speechAction,
      stageId: stageAccess ? stageId : null,
      plan: prepared.plan,
      profile: prepared.profile,
      config: speechConfig,
      reason: dynamic ? 'dynamic' : (body.reason ?? 'initial'),
      entry: dynamic ? 'dynamic' : 'route',
      persist: { kind: 'none' },
      recordUsage: true,
      routeId: prepared.route?.routeId,
    });
    if (outcome.outcome === 'failed' || !outcome.audio) {
      return apiError(outcome.error?.code ?? 'GENERATION_FAILED', 422, outcome.error?.message ?? 'failed');
    }

    // Convert to base64
    const base64 = Buffer.from(outcome.audio.bytes).toString('base64');

    return apiSuccess({
      audioId,
      base64,
      format: outcome.audio.format,
      // Additive (SATTS §7.2 step 3): the client stamps provenance with audioId.
      // Not with the flag off: the route read no Stage then, so a provenance
      // stamped now would not match the Stage-aware plan later (DEC-027); the
      // audio stays `legacy`, which later passes keep.
      ...(!dynamic && speechConfig.mode !== 'off' && outcome.provenance
        ? { provenance: outcome.provenance }
        : {}),
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings.map((w) => w.code) } : {}),
    });
  } catch (error) {
    log.error(
      `TTS generation failed [provider=${ttsProviderId ?? 'unknown'}, voice=${ttsVoice ?? 'unknown'}, audioId=${audioId ?? 'unknown'}]:`,
      error,
    );
    if (error instanceof TTSRateLimitError) {
      return apiError('RATE_LIMITED', 429, error.message);
    }
    if (error instanceof TTSInvalidResponseError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    if (error instanceof QwenVoiceCloneError) {
      return apiError(error.code, error.httpStatus || 502, qwenVoiceCloneErrorMessage(error));
    }
    if (error instanceof QwenTTSError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    if (error instanceof TTSModelNotAllowedError) {
      return apiError(error.code, error.httpStatus, error.message);
    }
    return apiError(
      'GENERATION_FAILED',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

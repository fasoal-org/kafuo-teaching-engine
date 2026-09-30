/**
 * Narration audio assessment (SATTS plan §7.2 step 4, §13.4).
 *
 * POST /api/generate/tts/assess
 * body: { stageId, ttsProviderId, ttsModelId?, ttsVoice, ttsSpeed?, actions: [{ id, text, audioId?, audioInvalidated?, audioProvenance? }] }
 * →    { mode, statuses: { [actionId]: { status, reason? } } }
 *
 * The browser asks this before a generation pass and synthesises only
 * `missing`/`stale` Actions. With SCIENTIFIC_TTS_MODE=off every Action is
 * `missing`, so a pass behaves exactly as today (DEC-002). No provider call.
 */
import { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveTTSModel } from '@/lib/server/provider-config';
import { readSpeechConfig } from '@/lib/server/speech/config';
import { assessNarrationAudio } from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import { governedSubjectFromStore, SpeechContextUnavailableError } from '@/lib/server/speech/speech-context';
import { loadStageForSpeech } from '@/lib/server/speech/stage-access';
import type { SpeechAction } from '@/lib/types/action';

const MAX_ACTIONS = 200;

interface AssessBody {
  stageId?: string;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
  actions?: Array<Pick<SpeechAction, 'id' | 'text' | 'audioId' | 'audioInvalidated' | 'audioProvenance'>>;
}

export async function POST(req: NextRequest) {
  let body: AssessBody;
  try {
    body = (await req.json()) as AssessBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  const actions = Array.isArray(body.actions) ? body.actions.slice(0, MAX_ACTIONS) : [];
  if (!body.ttsProviderId || !body.ttsVoice) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required fields: ttsProviderId, ttsVoice');
  }
  const config = readSpeechConfig();
  const statuses: Record<string, { status: string; reason?: string }> = {};
  if (config.mode === 'off') {
    for (const action of actions) statuses[action.id] = { status: 'missing' };
    return apiSuccess({ mode: config.mode, statuses });
  }
  let stage = null;
  if (body.stageId) {
    try {
      stage = await loadStageForSpeech(req, body.stageId, 'write');
    } catch (error) {
      if (error instanceof SpeechContextUnavailableError) return apiError(error.code, 503, error.message);
      throw error;
    }
  }
  const modelId = resolveTTSModel(body.ttsProviderId, body.ttsModelId, body.ttsVoice);
  for (const action of actions) {
    if (typeof action?.id !== 'string' || typeof action.text !== 'string') continue;
    const { plan, profile } = await prepareNarration({
      text: action.text,
      stage: stage?.stage ?? null,
      stageId: stage ? body.stageId : null,
      config,
      fallback: {
        providerId: body.ttsProviderId,
        modelId: modelId ?? '',
        requestModelId: modelId,
        voice: body.ttsVoice,
        speed: body.ttsSpeed ?? 1,
      },
      governedSubjectLookup: governedSubjectFromStore,
    });
    const assessment = assessNarrationAudio(action, plan, profile, config.mode);
    statuses[action.id] = {
      status: assessment.status,
      ...(assessment.reason ? { reason: assessment.reason } : {}),
    };
  }
  return apiSuccess({ mode: config.mode, statuses });
}

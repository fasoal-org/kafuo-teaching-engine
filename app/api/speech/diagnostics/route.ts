/**
 * Reviewer pronunciation diagnostics (SATTS plan §16.3, FR-010, FR-036).
 *
 * POST /api/speech/diagnostics
 * body: { stageId, sceneId?, actionIds?, mode?, synthesize?, ttsProviderId?, ttsModelId?, ttsVoice?, ttsSpeed? }
 *
 * Requires the Stage owner or an editor grant; a LEARNER grant is refused
 * (403). With `synthesize: true` and exactly one Action, returns preview
 * audio that is never persisted or stamped (outcome reason `preview`).
 */
import { NextRequest } from 'next/server';

import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveTTSModel } from '@/lib/server/provider-config';
import { readSpeechConfig } from '@/lib/server/speech/config';
import { diagnoseStage, type DiagnosticsDocument } from '@/lib/server/speech/diagnostics';
import { synthesizeNarration } from '@/lib/server/speech/narration-synthesis';
import { prepareNarration } from '@/lib/server/speech/prepare';
import { SpeechContextUnavailableError } from '@/lib/server/speech/speech-context';
import { loadStageForSpeech } from '@/lib/server/speech/stage-access';
import type { SpeechAction } from '@/lib/types/action';

export const maxDuration = 120;

interface DiagnosticsBody {
  stageId?: string;
  sceneId?: string;
  actionIds?: string[];
  mode?: 'natural' | 'accessible';
  synthesize?: boolean;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed?: number;
}

export async function POST(req: NextRequest) {
  let body: DiagnosticsBody;
  try {
    body = (await req.json()) as DiagnosticsBody;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  if (!body.stageId) return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: stageId');
  let access;
  try {
    access = await loadStageForSpeech(req, body.stageId, 'diagnostics');
  } catch (error) {
    if (error instanceof SpeechContextUnavailableError) return apiError(error.code, 503, error.message);
    throw error;
  }
  if (!access) return apiError('SATTS_DIAGNOSTICS_FORBIDDEN', 403, 'Pronunciation diagnostics need an owner or editor grant');
  const document = (await access.loadDocument()) as unknown as DiagnosticsDocument | null;
  if (!document) return apiError('SATTS_STAGE_NOT_FOUND', 404, 'Stage not found');

  const config = readSpeechConfig();
  const providerId = body.ttsProviderId || 'openai-tts';
  const voice = body.ttsVoice || 'alloy';
  const modelId = resolveTTSModel(providerId, body.ttsModelId, voice) ?? '';
  const fallback = { providerId, modelId, voice, speed: body.ttsSpeed ?? 1 };
  const actions = await diagnoseStage({
    document,
    config,
    fallback,
    sceneId: body.sceneId,
    actionIds: body.actionIds,
    mode: body.mode,
  });

  if (!body.synthesize) return apiSuccess({ mode: config.mode, actions });
  if (actions.length !== 1) return apiError('INVALID_REQUEST', 400, 'synthesize needs exactly one action');
  const target = actions[0]!;
  const action = { id: target.actionId, type: 'speech', text: target.original } as SpeechAction;
  const stage = body.mode ? { ...access.stage, speechReadingMode: body.mode } : access.stage;
  const previewConfig = { ...config, mode: 'on' as const };
  const { plan, profile } = await prepareNarration({
    text: action.text,
    stage,
    stageId: body.stageId,
    config: previewConfig,
    fallback,
    allowProposed: true,
  });
  const outcome = await synthesizeNarration({
    action,
    stageId: null,
    plan,
    profile,
    config: previewConfig,
    reason: 'preview',
    entry: 'preview',
    persist: { kind: 'none' },
    recordUsage: true,
  });
  if (outcome.outcome === 'failed' || !outcome.audio) {
    return apiError(outcome.error?.code ?? 'GENERATION_FAILED', 422, outcome.error?.message ?? 'failed');
  }
  return apiSuccess({
    mode: config.mode,
    actions,
    preview: { base64: Buffer.from(outcome.audio.bytes).toString('base64'), format: outcome.audio.format },
  });
}

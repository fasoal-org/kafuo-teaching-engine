/**
 * Reviewer diagnostics (plan §16.3, FR-010, FR-036): per speech Action, the
 * original text, the prepared (spoken) text, spans, warnings, the audio status
 * and the policy version — so an authorised reviewer can compare them without
 * playing audio. Proposed dictionary entries are used and marked experimental
 * (plan §11). Never exposed to learners (the route refuses learner grants).
 */
import { renderScientificSpeech } from '@/lib/speech/scientific';
import { loadPolicyPack } from '@/lib/speech/scientific/policy';
import type { RenderedSpan } from '@/lib/speech/scientific/result';
import type { RenderWarning } from '@/lib/speech/scientific/warnings';
import type { SpeechAction } from '@/lib/types/action';
import type { SpeechConfig } from './config';
import { assessNarrationAudio, type AssessStatus, type StaleReason } from './narration-synthesis';
import { prepareNarration } from './prepare';
import type { StageSpeechFields } from './speech-context';
import type { FallbackProfile } from './speech-profile';

export interface ActionDiagnostics {
  sceneId: string;
  actionId: string;
  original: string;
  prepared: string;
  path: 'general' | 'scientific';
  spans: RenderedSpan[];
  warnings: RenderWarning[];
  blocking: string | null;
  status: AssessStatus;
  staleReason?: StaleReason;
  policyVersion: string | null;
  policyStatus: 'approved' | 'experimental';
}

export interface DiagnosticsDocument {
  stage: StageSpeechFields & { id: string };
  scenes: Array<{ id: string; actions?: unknown[] }>;
}

export async function diagnoseStage(input: {
  document: DiagnosticsDocument;
  config: SpeechConfig;
  fallback: FallbackProfile;
  sceneId?: string;
  actionIds?: readonly string[];
  /** Override the Stage's reading mode for the comparison (not persisted). */
  mode?: 'natural' | 'accessible';
}): Promise<ActionDiagnostics[]> {
  const { document, config } = input;
  const stage = input.mode ? { ...document.stage, speechReadingMode: input.mode } : document.stage;
  const wanted = input.actionIds ? new Set(input.actionIds) : null;
  const out: ActionDiagnostics[] = [];
  const policy = loadPolicyPack(null, { allowProposed: true });
  // Diagnostics always show the scientific reading the Stage would get with the flag on.
  const diagnosticConfig: SpeechConfig = { ...config, mode: 'on' };
  for (const scene of document.scenes) {
    if (input.sceneId && scene.id !== input.sceneId) continue;
    for (const raw of (scene.actions ?? []) as SpeechAction[]) {
      if (raw?.type !== 'speech' || typeof raw.text !== 'string') continue;
      if (wanted && !wanted.has(raw.id)) continue;
      const { context, profile, plan } = await prepareNarration({
        text: raw.text,
        stage,
        stageId: document.stage.id,
        config: diagnosticConfig,
        fallback: input.fallback,
        allowProposed: true,
      });
      const rendered = renderScientificSpeech({ context }, policy);
      const assessment = assessNarrationAudio(raw, plan, profile, config.mode);
      out.push({
        sceneId: scene.id,
        actionId: raw.id,
        original: raw.text,
        prepared: rendered.preparedText,
        path: rendered.path,
        spans: rendered.spans,
        warnings: rendered.warnings,
        blocking: rendered.blocking?.code ?? null,
        status: assessment.status,
        ...(assessment.reason ? { staleReason: assessment.reason } : {}),
        policyVersion: rendered.policyVersion,
        policyStatus: policy.status,
      });
    }
  }
  return out;
}

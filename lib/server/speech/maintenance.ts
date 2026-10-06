/**
 * Operator maintenance logic for SATTS (plan §13.4, §18.2, D-7), kept pure so
 * it is tested without a database. The scripts under `scripts/satts-*.ts`
 * are thin wrappers:
 *
 * - `revalidateDocument`: after a policy bump, recompute each scientific
 *   Action's prepared digest. Unchanged → only `policyVersion` would be
 *   rewritten; changed → reported stale. Writes nothing unless `apply`.
 * - `planSubjectBackfill`: which Stages lack `subjectCode` but have one in the
 *   governed attempt snapshot. A proposal only.
 * - `inventoryDocument`: read-only counts of legacy scientific audio (D-7).
 */
import { renderScientificSpeech } from '@/lib/speech/scientific';
import { isArabicLanguage, isScientificSubjectCode } from '@/lib/speech/scientific/context';
import { detectExpressions } from '@/lib/speech/scientific/detect';
import type { PolicyPack } from '@/lib/speech/scientific/policy';
import { sanitizeAudioProvenance, type SpeechAction } from '@/lib/types/action';
import { sha256Hex } from './delivery-instructions';

export interface MaintenanceDocument {
  stage: { id: string; subjectCode?: string; language?: string; speechReadingMode?: string };
  scenes: Array<{ id: string; actions?: unknown[] }>;
}

function speechActions(document: MaintenanceDocument): Array<{ sceneId: string; action: SpeechAction }> {
  return document.scenes.flatMap((scene) =>
    ((scene.actions ?? []) as SpeechAction[])
      .filter((action) => action?.type === 'speech' && typeof action.text === 'string')
      .map((action) => ({ sceneId: scene.id, action })),
  );
}

export interface RevalidationReport {
  stageId: string;
  /** Prepared text unchanged: only `policyVersion` moves to the new version. */
  promotable: Array<{ actionId: string; from: string | null; to: string }>;
  /** Prepared text changed: eligible for an explicitly confirmed regeneration. */
  stale: Array<{ actionId: string; reason: 'prepared' | 'text' }>;
  /** Actions without scientific provenance (general or legacy): untouched. */
  skipped: number;
}

export function revalidateDocument(
  document: MaintenanceDocument,
  policy: PolicyPack,
  options: { apply?: boolean } = {},
): { report: RevalidationReport; document: MaintenanceDocument } {
  const copy: MaintenanceDocument = options.apply ? structuredClone(document) : document;
  const report: RevalidationReport = { stageId: document.stage.id, promotable: [], stale: [], skipped: 0 };
  for (const { action } of speechActions(copy)) {
    const provenance = sanitizeAudioProvenance(action.audioProvenance);
    if (!action.audioId || !provenance || provenance.policyVersion === null || !provenance.subjectCode) {
      report.skipped += 1;
      continue;
    }
    if (provenance.originalDigest !== sha256Hex(action.text)) {
      report.stale.push({ actionId: action.id, reason: 'text' });
      continue;
    }
    const subject = provenance.subjectCode;
    const rendered = renderScientificSpeech(
      {
        context: {
          originalText: action.text,
          subjectCode: isScientificSubjectCode(subject) ? subject : null,
          subjectSource: 'stage',
          language: provenance.language ?? null,
          readingMode: provenance.readingMode ?? 'natural',
          policyVersion: policy.policyVersion,
          policyStatus: policy.status,
        },
      },
      policy,
    );
    if (sha256Hex(rendered.preparedText) === provenance.preparedDigest) {
      report.promotable.push({ actionId: action.id, from: provenance.policyVersion, to: policy.policyVersion });
      if (options.apply) {
        action.audioProvenance = { ...provenance, policyVersion: policy.policyVersion, policyStatus: policy.status };
      }
    } else {
      report.stale.push({ actionId: action.id, reason: 'prepared' });
    }
  }
  return { report, document: copy };
}

export interface BackfillProposal {
  stageId: string;
  subjectCode: string;
}

export async function planSubjectBackfill(
  stages: Array<{ id: string; subjectCode?: string | null }>,
  governedSubject: (stageId: string) => Promise<string | null>,
): Promise<BackfillProposal[]> {
  const proposals: BackfillProposal[] = [];
  for (const stage of stages) {
    if (stage.subjectCode) continue;
    const code = await governedSubject(stage.id);
    if (code && /^[A-Z_]{2,32}$/.test(code)) proposals.push({ stageId: stage.id, subjectCode: code });
  }
  return proposals;
}

export interface InventoryRow {
  stageId: string;
  subjectCode: string;
  speechActions: number;
  legacyAudioActions: number;
  legacyWithExpressions: number;
  /** Characters that a regeneration would send (renderer output, proposed entries allowed). */
  regenerationChars: number;
}

export function inventoryDocument(
  document: MaintenanceDocument,
  subjectCode: string,
  policy: PolicyPack,
): InventoryRow | null {
  if (!isScientificSubjectCode(subjectCode)) return null;
  const language = document.stage.language ?? 'ar';
  const row: InventoryRow = {
    stageId: document.stage.id,
    subjectCode,
    speechActions: 0,
    legacyAudioActions: 0,
    legacyWithExpressions: 0,
    regenerationChars: 0,
  };
  for (const { action } of speechActions(document)) {
    row.speechActions += 1;
    if (!action.audioId || sanitizeAudioProvenance(action.audioProvenance)) continue;
    row.legacyAudioActions += 1;
    if (detectExpressions(action.text, subjectCode).length === 0 || !isArabicLanguage(language)) continue;
    row.legacyWithExpressions += 1;
    row.regenerationChars += renderScientificSpeech(
      {
        context: {
          originalText: action.text,
          subjectCode,
          subjectSource: 'stage',
          language,
          readingMode: 'natural',
          policyVersion: policy.policyVersion,
          policyStatus: policy.status,
        },
      },
      policy,
    ).preparedText.length;
  }
  return row;
}

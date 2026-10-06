/**
 * Builds the authoritative SpeechContext (plan §8.1). The subject comes from
 * the persisted Stage, or — for a legacy governed Stage without the field —
 * from the governed attempt snapshot through the version's predecessor walk
 * (a trusted metadata lookup, never inference). Nothing is ever read from a
 * request body and nothing is guessed from the text (FR-001, FR-004, AS-011).
 */
import {
  isArabicLanguage,
  isScientificSubjectCode,
  type SpeechContext,
} from '@/lib/speech/scientific/context';
import type { PolicyPack } from '@/lib/speech/scientific/policy';
import type { SpeechConfig } from './config';

export interface StageSpeechFields {
  subjectCode?: unknown;
  language?: unknown;
  speechReadingMode?: unknown;
}

/** Looks up the governed attempt's subject for a Stage; throws when the store fails. */
export type GovernedSubjectLookup = (stageId: string) => Promise<string | null>;

export class SpeechContextUnavailableError extends Error {
  readonly code = 'SATTS_E_CONTEXT_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'SpeechContextUnavailableError';
  }
}

export interface ResolvedSpeechContext {
  context: SpeechContext;
  /** The Stage's subject (possibly non-scientific), recorded in provenance. */
  stageSubjectCode: string | null;
}

export async function resolveSpeechContext(input: {
  originalText: string;
  stage: StageSpeechFields | null;
  stageId?: string | null;
  config: SpeechConfig;
  policy: PolicyPack;
  governedSubjectLookup?: GovernedSubjectLookup;
}): Promise<ResolvedSpeechContext> {
  const { stage, config, policy } = input;
  const language = typeof stage?.language === 'string' && stage.language.trim() ? stage.language : null;
  const readingMode = stage?.speechReadingMode === 'accessible' ? 'accessible' : 'natural';

  let stageSubjectCode =
    typeof stage?.subjectCode === 'string' && stage.subjectCode.trim() ? stage.subjectCode : null;
  let subjectSource: SpeechContext['subjectSource'] = stageSubjectCode ? 'stage' : 'none';

  // The legacy fallback is only consulted when the flag can use the answer.
  if (!stageSubjectCode && config.mode !== 'off' && input.stageId && input.governedSubjectLookup) {
    let recovered: string | null;
    try {
      recovered = await input.governedSubjectLookup(input.stageId);
    } catch (error) {
      throw new SpeechContextUnavailableError(
        `governed subject lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (recovered) {
      stageSubjectCode = recovered;
      subjectSource = 'governed-attempt';
    }
  }

  const applied =
    stageSubjectCode &&
    isScientificSubjectCode(stageSubjectCode) &&
    config.subjects.has(stageSubjectCode) &&
    isArabicLanguage(language)
      ? stageSubjectCode
      : null;

  return {
    context: {
      originalText: input.originalText,
      subjectCode: applied,
      subjectSource: applied ? subjectSource : 'none',
      language,
      readingMode,
      policyVersion: policy.policyVersion,
      policyStatus: policy.status,
    },
    stageSubjectCode,
  };
}

/**
 * The production lookup: `teaching_package_versions.current_stage_id` →
 * `readRetainedVersionContext` → `inputSnapshot.subjectCode`. Returns `null`
 * without a database or when the Stage is not governed.
 */
export const governedSubjectFromStore: GovernedSubjectLookup = async (stageId) => {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { readRetainedVersionContext } = await import('@/lib/persistence/teaching-package');
  const { pool } = await getServerPersistenceProvider(url);
  const result = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM teaching_package_versions WHERE current_stage_id = $1 LIMIT 1`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const retained = await readRetainedVersionContext(pool, row.id, { tenantId: row.tenant_id });
  const code = retained?.inputSnapshot.subjectCode;
  return typeof code === 'string' && code.trim() ? code : null;
};

/**
 * The authoritative context a narration is rendered in. Built on the server
 * from the persisted Stage (never from a request body, never from the text).
 * Pure data — no I/O.
 */

/** The subjects that have a V1 pronunciation grammar. */
export type ScientificSubjectCode = 'MATH' | 'PHYSICS' | 'CHEMISTRY';

export const SCIENTIFIC_SUBJECT_CODES = [
  'MATH',
  'PHYSICS',
  'CHEMISTRY',
] as const satisfies readonly ScientificSubjectCode[];

export function isScientificSubjectCode(value: unknown): value is ScientificSubjectCode {
  return (
    typeof value === 'string' && (SCIENTIFIC_SUBJECT_CODES as readonly string[]).includes(value)
  );
}

export type SpeechReadingModeValue = 'natural' | 'accessible';

export interface SpeechContext {
  /** The persisted `SpeechAction.text`, byte-exact. */
  originalText: string;
  /** `null` selects the general path (identity render). */
  subjectCode: ScientificSubjectCode | null;
  /** Where the subject came from. */
  subjectSource: 'stage' | 'governed-attempt' | 'none';
  /** `Stage.language` (BCP-47) or `null`. */
  language: string | null;
  /** `Stage.speechReadingMode ?? 'natural'`. */
  readingMode: SpeechReadingModeValue;
  /** From the loaded policy pack, e.g. `satts-ar-1.0.0`. */
  policyVersion: string;
  policyStatus: 'approved' | 'experimental';
}

/** True when `language` has the primary subtag `ar` (`ar`, `ar-SA`, `ar-EG`, …). */
export function isArabicLanguage(language: string | null | undefined): boolean {
  if (typeof language !== 'string') return false;
  const primary = language.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary === 'ar';
}

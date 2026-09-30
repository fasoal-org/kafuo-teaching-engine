import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPolicyPack, renderScientificSpeech } from '@/lib/speech/scientific';
import type { ScientificSubjectCode, SpeechContext } from '@/lib/speech/scientific/context';
import type { PolicyPackOptions } from '@/lib/speech/scientific/policy';

/** Test-only policy: proposed entries allowed (goal prompt constraint 9). */
export const TEST_POLICY = loadPolicyPack('ar', { allowProposed: true });

export function context(
  originalText: string,
  subjectCode: ScientificSubjectCode | null = 'MATH',
  readingMode: 'natural' | 'accessible' = 'natural',
): SpeechContext {
  return {
    originalText,
    subjectCode,
    subjectSource: subjectCode ? 'stage' : 'none',
    language: 'ar-SA',
    readingMode,
    policyVersion: TEST_POLICY.policyVersion,
    policyStatus: 'experimental',
  };
}

export function render(
  text: string,
  subject: ScientificSubjectCode | null = 'MATH',
  mode: 'natural' | 'accessible' = 'natural',
  options: PolicyPackOptions = { allowProposed: true },
) {
  return renderScientificSpeech({ context: context(text, subject, mode) }, loadPolicyPack('ar', options));
}

export function prepared(
  text: string,
  subject: ScientificSubjectCode | null = 'MATH',
  mode: 'natural' | 'accessible' = 'natural',
): string {
  return render(text, subject, mode).preparedText;
}

/** Warning codes other than the informational proposed-entry notice. */
export function codes(result: ReturnType<typeof render>): string[] {
  return result.warnings
    .map((w) => w.code)
    .filter((code) => code !== 'SATTS_W_UNPROMOTED_POLICY_ENTRY')
    .sort();
}

export interface GoldenCase {
  id: string;
  category: string;
  subject: ScientificSubjectCode;
  language: string;
  original: string;
  expressionBoundaries: string[];
  expected: { natural: string; accessible: string };
  semanticExpansionAllowed: boolean;
  expectedWarnings: string[];
  expectedBlocking: string | null;
  reviewerApproval: 'pending' | 'approved';
  status: 'proposed' | 'approved';
  notes: string;
}

export const GOLDEN_DIR = join(__dirname, 'golden');

export function loadGolden(): Array<GoldenCase & { file: string }> {
  const out: Array<GoldenCase & { file: string }> = [];
  for (const file of readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(GOLDEN_DIR, file), 'utf8').split('\n')) {
      if (line.trim()) out.push({ ...(JSON.parse(line) as GoldenCase), file });
    }
  }
  return out;
}

/** Audit regression set (upgrade plan P0): see `audit.test.ts`. */
export interface AuditCase {
  id: string;
  /** The upgrade-plan phase that enforces the target. */
  phase: string;
  status: 'pending' | 'enforced';
  subject: ScientificSubjectCode;
  mode: 'natural' | 'accessible';
  /** `production`: `allowProposed: false`; `proposed`: the experimental pack. */
  policy: 'proposed' | 'production';
  original: string;
  expected: string;
  /** Today's reading has a different meaning from the source. */
  wrongMeaning: boolean;
  /** A warning code the target reading must carry. */
  expectWarning?: string;
  /** Another case whose reading must sound different. */
  distinctFrom?: string;
  notes: string;
}

export function loadAudit(): AuditCase[] {
  return readFileSync(join(GOLDEN_DIR, 'audit', 'audit-p0.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditCase);
}

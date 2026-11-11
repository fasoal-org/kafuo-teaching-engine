/**
 * The package reviewer's prompt, output schema and validator
 * (ai-reviewer-layer plan §4.2, §4.3, D-4, D-9).
 *
 * Order, for prompt caching: the fixed instructions + checklist (system), then
 * the book units (a cache-marked stable block), then the slides. A re-review
 * (Phase 3) sends the same system and book block and only the changed slides
 * with their neighbours.
 *
 * The validator is the authority: an answer that does not parse, names an
 * unknown check, or targets a slide that was not sent is `unusable_output`,
 * which the executor answers with the fallback route.
 */
import type {
  ReviewBookUnit,
  ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';

export const PACKAGE_REVIEW_PROMPT_VERSION = 'package-review-v1';

export const SLIDE_CHECKS = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
/** The question checks a package quiz Scene is reviewed with (plan §4.3). */
export const PACKAGE_QUIZ_CHECKS = ['Q1', 'Q2', 'Q5'] as const;
export type PackageReviewCheck =
  | (typeof SLIDE_CHECKS)[number]
  | (typeof PACKAGE_QUIZ_CHECKS)[number];
export const PACKAGE_REVIEW_CHECKS: readonly PackageReviewCheck[] = [
  ...SLIDE_CHECKS,
  ...PACKAGE_QUIZ_CHECKS,
];
export type FindingSeverity = 'high' | 'medium' | 'low';

export interface ReviewerFinding {
  /** The Scene id; `''` only for an S5 finding about a part missing from the whole package. */
  targetId: string;
  check: PackageReviewCheck;
  severity: FindingSeverity;
  bookEvidence: { quote: string; unitId: string | null };
  whatIsWrong: string;
  fixNote: string;
}

export interface ReviewerAnswer {
  summary: string;
  findings: ReviewerFinding[];
}

const TEXT_MAX = 2_000;
const QUOTE_MAX = 1_200;
const SUMMARY_MAX = 3_000;
const FINDINGS_MAX = 80;

const PACKAGE_REVIEW_INSTRUCTIONS = `You are the senior subject reviewer of a Saudi school lesson ("Teaching Package") that was generated from a textbook. You read the book text the lesson was built from and check every slide and every in-lesson quiz against a fixed checklist. You only report real errors; you never report taste or style preferences that the checklist does not name.

CHECKLIST (use exactly these codes)
- S1: The slide and its narration match the book. Nothing is added that the book does not say, and nothing contradicts it.
- S2: Every calculation and worked example is right. Re-solve each one yourself, step by step, before you judge it.
- S3: The numbers, values and givens are the book's (not changed, not invented).
- S4: The Arabic is clear and in the agreed Saudi spoken teaching style, with no English leftovers, no internal labels or ids, and no placeholder text.
- S5: Every lesson part of the book is present, in book order. Report a part that is missing or out of order.
- Q1 (quiz slides): solve the question yourself. The marked answer is right, and no other option is also right.
- Q2 (quiz slides): the question is clear and has one reading.
- Q5 (quiz slides): the explanation is correct.

RULES
- Quote the book for every finding (book_evidence.quote: the exact words, at most two sentences; book_evidence.unit_id: the unit id, or "" when the book is one block). If the book says nothing about it, quote the closest relevant words and say so.
- what_is_wrong: one or two sentences in Arabic for the teacher: what is wrong and what the book says.
- fix_note: one instruction in Arabic that a slide writer can follow to fix exactly this error (for S2, include the correct working and the correct result). It must not ask to add, remove or move slides.
- severity: high = a student would learn something false or a wrong answer is marked right; medium = misleading or unclear; low = a small language or style slip.
- target_id: the slide id exactly as given. For S5 about a part missing from the whole lesson, use "".
- Never report the same error twice. A slide with no error gets no finding.
- summary: one short paragraph in Arabic for the teacher: what you checked, how many errors, and the most important one. If there are no errors, say so plainly.
- Answer with JSON only, matching the schema.`;

/** The JSON schema sent as native structured output (Anthropic) and enforced by `validate`. */
export const PACKAGE_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target_id', 'check', 'severity', 'book_evidence', 'what_is_wrong', 'fix_note'],
        properties: {
          target_id: { type: 'string' },
          check: { type: 'string', enum: [...PACKAGE_REVIEW_CHECKS] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          book_evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['quote', 'unit_id'],
            properties: { quote: { type: 'string' }, unit_id: { type: 'string' } },
          },
          what_is_wrong: { type: 'string' },
          fix_note: { type: 'string' },
        },
      },
    },
  },
};

/**
 * The schema, verbatim, at the end of the fixed instructions. Only Anthropic
 * receives it as native structured output (`execute.ts`); GPT-6 Sol answers in
 * text mode, so it must read the exact key names here (review finding H-1).
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `OUTPUT: exactly one JSON object that matches this JSON schema, with these exact key names. No markdown, no code fence, no text before or after it.\n${JSON.stringify(schema)}`;
}

export const PACKAGE_REVIEW_SYSTEM = `${PACKAGE_REVIEW_INSTRUCTIONS}\n\n${schemaInstruction(PACKAGE_REVIEW_SCHEMA)}`;

/**
 * The JSON text of an answer: a model in text mode may still wrap it in a
 * markdown fence; nothing else is repaired.
 */
export function unwrapJsonAnswer(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** D-8: the one sentence the reviewer reads when it does not see the whole book. */
export const BOOK_TRUNCATED_NOTE =
  'NOTE: this book text was cut to fit one review, so part of the book is missing here; never report a lesson part as missing (S5) only because it is not in this text.';

/**
 * The stable, cache-marked block: the book units, once. A cut book (D-8) adds
 * one sentence saying so; an uncut book renders exactly as before.
 */
export function renderBookBlock(
  units: readonly ReviewBookUnit[],
  options: { truncated?: boolean } = {},
): string {
  const lines = ['BOOK TEXT (the authority):'];
  if (options.truncated) lines.push(BOOK_TRUNCATED_NOTE);
  for (const unit of units) {
    const head = [
      `unit_id=${unit.id}`,
      unit.role ? `role=${unit.role}` : null,
      unit.title ? `title=${unit.title}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
    lines.push(`<<UNIT ${head}>>`, unit.text, '<<END UNIT>>');
  }
  return lines.join('\n');
}

function renderSlide(slide: ReviewSlide): string {
  const lines = [
    `<<SLIDE id=${slide.id} | order=${slide.order} | type=${slide.sceneType}${
      slide.contentRole ? ` | contentRole=${slide.contentRole}` : ''
    } | cited_units=${slide.citedUnitIds.join(',') || 'none'}>>`,
    `TITLE: ${slide.title}`,
  ];
  if (slide.visibleText) lines.push('VISIBLE TEXT:', slide.visibleText);
  for (const [index, question] of (slide.questions ?? []).entries()) {
    lines.push(`QUESTION ${index + 1}: ${question.question}`);
    for (const option of question.options) lines.push(`  (${option.value}) ${option.label}`);
    lines.push(`  MARKED ANSWER: ${question.answer.join(', ') || 'none'}`);
    if (question.explanation) lines.push(`  EXPLANATION: ${question.explanation}`);
  }
  if (slide.narration) lines.push('NARRATION:', slide.narration);
  lines.push('<<END SLIDE>>');
  return lines.join('\n');
}

/**
 * The variable block. `focusIds` (a re-review) lists the slides to check; the
 * others are context only and must not get findings.
 */
export function renderSlidesBlock(
  slides: readonly ReviewSlide[],
  focusIds?: ReadonlySet<string>,
): string {
  const head = focusIds
    ? `RE-REVIEW. Check ONLY these slides: ${[...focusIds].join(', ')}. The other slides are neighbours for context; report nothing about them, and do not use S5.`
    : 'LESSON SLIDES, in order. Check every slide.';
  return [head, ...slides.map(renderSlide)].join('\n\n');
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Parse and check one answer. Throws on a malformed answer (→ fallback);
 * drops, never invents, findings outside the reviewed slides.
 */
export function parseReviewerAnswer(
  raw: string,
  scope: {
    slideIds: ReadonlySet<string>;
    quizIds: ReadonlySet<string>;
    focusIds?: ReadonlySet<string>;
  },
): ReviewerAnswer {
  const value = JSON.parse(unwrapJsonAnswer(raw)) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the answer must be a JSON object');
  }
  const summary = text(value.summary, 'summary', SUMMARY_MAX);
  if (!Array.isArray(value.findings)) throw new Error('findings must be an array');
  const findings: ReviewerFinding[] = [];
  const seen = new Set<string>();
  for (const entry of value.findings.slice(0, FINDINGS_MAX) as unknown[]) {
    const f = entry as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') throw new Error('a finding must be an object');
    const check = f.check as PackageReviewCheck;
    if (!PACKAGE_REVIEW_CHECKS.includes(check)) throw new Error(`unknown check ${String(f.check)}`);
    const severity = f.severity as FindingSeverity;
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error(`unknown severity ${String(f.severity)}`);
    }
    const targetId = text(f.target_id, 'target_id', 200);
    const evidence = (f.book_evidence ?? {}) as Record<string, unknown>;
    const finding: ReviewerFinding = {
      targetId,
      check,
      severity,
      bookEvidence: {
        quote: text(evidence.quote, 'book_evidence.quote', QUOTE_MAX),
        unitId: text(evidence.unit_id ?? '', 'book_evidence.unit_id', 200) || null,
      },
      whatIsWrong: text(f.what_is_wrong, 'what_is_wrong', TEXT_MAX),
      fixNote: text(f.fix_note, 'fix_note', TEXT_MAX),
    };
    // Scope: a finding on a slide that was not reviewed is dropped, never kept.
    const packageLevelS5 = check === 'S5' && targetId === '' && !scope.focusIds;
    if (!packageLevelS5 && !scope.slideIds.has(targetId)) continue;
    if (scope.focusIds && !scope.focusIds.has(targetId)) continue;
    // A quiz check only on a quiz Scene; a slide check only on a slide Scene.
    const isQuizCheck = (PACKAGE_QUIZ_CHECKS as readonly string[]).includes(check);
    if (targetId && isQuizCheck !== scope.quizIds.has(targetId) && check !== 'S5') continue;
    const key = `${targetId}|${check}|${finding.whatIsWrong}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }
  return { summary, findings };
}

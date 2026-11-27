/**
 * g5.v12 (critical items before package regeneration, 27 Nov 2026: QZ-2, decision Q-AK):
 * nothing unverified enters the question bank.
 *
 * Each objective's check quiz (`outcome_check_understanding`, never an attempt) is what the
 * Backend imports into the question bank at approval (`/quizzes`, the check scenes only).
 * Until now its keys were the model's own; code only normalised their shape. On g5.v12:
 *
 * - References: the approved answers of the book items the quiz cites — the teacher guide's
 *   keyed items (`ResolvedTeacherGuide.keyed`) whose unit the quiz cites. Nothing else is a
 *   reference: a per-unit book `reference_answer` is not in the request contract.
 * - The quiz is written from them: one question per reference, each tagged with its
 *   reference (`R1`…), a single-answer question whose correct option states the approved
 *   answer (`referenceDirective`).
 * - A code comparator checks every key (`compareGuideAnswer`, the one comparator the
 *   guide answers use): the tagged reference must exist, the question must have exactly
 *   one correct option, and that option must state the approved answer — a number within
 *   its tolerance and unit, the same truth value, the same text, or for a book choice the
 *   same option letter. A number that reads two ways is not verified.
 * - On a mismatch the quiz is generated ONCE more with the approved answers named
 *   (`keyCorrection`); what is still unverified is DROPPED, never shipped.
 * - No reference at all (today: the Backend sends the guide for g5.v11 only), or no
 *   question left: the quiz is not generated (no paid call for keys no one can check); the
 *   run keeps a placeholder marked `CHECK_QUIZ_KEY_UNVERIFIED`, which Submit and approval
 *   refuse (`SLIDES_NEED_REGENERATION`) — fail closed.
 *
 * The reference tag never reaches a learner or the bank: it is stripped from every
 * verified question. No answer is ever logged: references are named by tag and item.
 */
import { compareGuideAnswer } from '@/lib/server/teaching-package/guide-answer-compare';
import {
  formatGuideAnswer,
  guideItemQuestionText,
  type KeyedGuideItem,
  type ResolvedTeacherGuide,
} from '@/lib/server/teaching-package/guide-answers';
import { isAttemptOutline } from '@/lib/server/teaching-package/attempt-quizzes';
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizQuestion } from '@/lib/types/stage';

/** The scene issue of a check quiz left with no verified key (Submit refuses it). */
export const CHECK_QUIZ_KEY_UNVERIFIED = 'CHECK_QUIZ_KEY_UNVERIFIED';

/** The flow stage whose quiz the question bank imports. */
const CHECK_QUIZ_STAGE = 'outcome_check_understanding';

/** The field a question names its reference in (stripped before anything is saved). */
const REFERENCE_FIELD = 'reference';

export interface CheckQuizReference {
  /** The tag a question names it by: `R1`, `R2`, … in the quiz's own order. */
  tag: string;
  item: KeyedGuideItem;
  /** The book's own question text for the item, when its unit text is known. */
  question: string | null;
}

/** A check quiz the question bank imports: a quiz at the check stage, never an attempt. */
export function isBankedCheckQuiz(
  outline: Pick<SceneOutline, 'id' | 'type' | 'teachingStage'>,
): boolean {
  return (
    outline.type === 'quiz' &&
    outline.teachingStage?.key === CHECK_QUIZ_STAGE &&
    !isAttemptOutline(outline)
  );
}

/**
 * The references of a check quiz: the guide's keyed items of the units it cites, in book
 * order. Empty without a guide, or when none of its items is cited.
 */
export function checkQuizReferences(
  outline: Pick<SceneOutline, 'sourceContentUnitIds'>,
  guide: Pick<ResolvedTeacherGuide, 'keyed'> | null | undefined,
  unitTexts?: ReadonlyMap<string, string>,
): CheckQuizReference[] {
  if (!guide) return [];
  const cited = new Set((outline.sourceContentUnitIds ?? []).map(String));
  return guide.keyed
    .filter((item) => cited.has(String(item.contentUnitId)))
    .map((item, index) => {
      const text = unitTexts?.get(String(item.contentUnitId));
      const question = text ? guideItemQuestionText(text, item).trim() : '';
      return { tag: `R${index + 1}`, item, question: question || null };
    });
}

function describeReference(reference: CheckQuizReference): string {
  const question = reference.question ? `\n   Book question: ${reference.question}` : '';
  return `- ${reference.tag} (book item ${reference.item.display})${question}\n   Approved answer: ${formatGuideAnswer(reference.item.answer)}`;
}

/** The instruction every generation of a keyed check quiz carries. */
export function referenceDirective(references: readonly CheckQuizReference[]): string {
  return [
    'ANSWER KEYS ARE CHECKED BY CODE. Write the questions ONLY from the book items below, at most one question per item:',
    ...references.map(describeReference),
    `Every question: "type": "single", exactly one correct option, and a "${REFERENCE_FIELD}" field naming its item ("R1", …). Its correct option must state that item's approved answer exactly (the same number and unit, the same truth value, the same words; for a choice answer keep the book's options in the book's order, so the correct option's value is the approved letter). A question that names no item, names an unknown item, or keys anything but the approved answer is removed.`,
  ].join('\n');
}

export interface CheckQuizVerification {
  /** The verified questions, in order, without their reference tag. */
  verified: QuizQuestion[];
  /** The removed questions: their position, their tag (if any) and why (no answer text). */
  failed: Array<{ index: number; tag: string | null; reason: string }>;
}

/** Each question's key against its reference; only a verified question is kept. */
export function verifyCheckQuizKeys(
  questions: readonly QuizQuestion[],
  references: readonly CheckQuizReference[],
): CheckQuizVerification {
  const byTag = new Map(references.map((reference) => [reference.tag, reference] as const));
  const used = new Set<string>();
  const verified: QuizQuestion[] = [];
  const failed: CheckQuizVerification['failed'] = [];
  questions.forEach((question, index) => {
    const raw = (question as unknown as Record<string, unknown>)[REFERENCE_FIELD];
    const tag = typeof raw === 'string' ? raw.trim().toUpperCase() : null;
    const fail = (reason: string) => failed.push({ index, tag, reason });
    const reference = tag ? byTag.get(tag) : undefined;
    if (!reference) return fail(tag ? 'names an unknown book item' : 'names no book item');
    if (used.has(reference.tag)) return fail('a second question on the same book item');
    if (question.type !== 'single') return fail(`a ${question.type} question cannot be checked`);
    const answer = question.answer ?? [];
    if (answer.length !== 1) return fail('not exactly one correct option');
    const option = (question.options ?? []).find((entry) => entry.value === answer[0]);
    if (!option) return fail('its key names no option');
    const written = reference.item.answer.type === 'choice' ? option.value : option.label;
    const comparison = compareGuideAnswer(reference.item.answer, written);
    if (!comparison.match) {
      return fail(
        comparison.undecided
          ? 'its key cannot be read one way'
          : 'its key is not the approved answer',
      );
    }
    used.add(reference.tag);
    const { [REFERENCE_FIELD]: _tag, ...rest } = question as unknown as Record<string, unknown>;
    verified.push(rest as unknown as QuizQuestion);
  });
  return { verified, failed };
}

/** The correction of the ONE regeneration: what failed, and each reference's approved answer. */
export function keyCorrection(
  failed: CheckQuizVerification['failed'],
  references: readonly CheckQuizReference[],
): string {
  return [
    `The previous answer had ${failed.length} question(s) whose key could not be verified (${failed
      .map((entry) => `question ${entry.index + 1}: ${entry.reason}`)
      .join('; ')}).`,
    'Write the quiz again. Each question names its book item and keys exactly its approved answer:',
    ...references.map(describeReference),
  ].join('\n');
}

/** The scene issue of a check quiz left with no verified key. */
export function unverifiedCheckQuizIssue(reason: string): { code: string; message: string } {
  return {
    code: CHECK_QUIZ_KEY_UNVERIFIED,
    message: `the check quiz has no verified answer key (${reason}); it cannot be submitted or enter the question bank until it is generated from the approved answers`,
  };
}

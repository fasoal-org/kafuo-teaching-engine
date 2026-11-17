/**
 * g5.v11 (teacher-guide answer referee plan §8, review findings 2, 9 and 10): the ONE
 * way a package's pinned guide is read after its run — by a single-scene regeneration
 * (the editor and the AI reviewer's fix loop), a slide insertion and the AI reviewer —
 * so each sees the run's own items, unit texts and exercise selection. Pure; the callers
 * read the attempt snapshot and the retained content units. Null for every other
 * Teaching Model, so g5.v8–v10 read nothing new.
 *
 * Also the pinned settlements' helpers: a run's settlements are MERGED into the attempt
 * snapshot (never overwritten) and the attempts they dropped are filtered from a resumed
 * run's outline, so `insertAttemptQuizzes` never inserts one again.
 */
import {
  bookUnitFactsOf,
  isGuideAnswerModel,
  isSacredExerciseElement,
  teacherParityBook,
  withTypedPracticeUnits,
} from '@/lib/server/teaching-package/book-coverage';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import {
  createGuideAnswerGuard,
  type GuideAnswerGuard,
  type GuideAnswerSettlement,
} from '@/lib/server/teaching-package/guide-answer-guard';
import {
  guideItemKey,
  guideOutlinePlans,
  resolveTeacherGuide,
  type ResolvedTeacherGuide,
} from '@/lib/server/teaching-package/guide-answers';
import { guideWrittenAttempts } from '@/lib/server/teaching-package/guide-written-attempts';
import type { BookUnitFacts } from '@/lib/server/teaching-package/hidden-step-types';
import { stripProviderImageDescriptions } from '@/lib/server/teaching-package/learner-first-source';
import { withoutSacredItems } from '@/lib/server/teaching-package/sacred-text';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GuideAnswerSettlementRecord,
  KafuoBookStructure,
  KafuoTeacherGuide,
} from '@/lib/types/teaching-package';

export interface GuideAnswerContext {
  book: KafuoBookStructure;
  resolved: ResolvedTeacherGuide;
  facts: Record<string, BookUnitFacts>;
  /** The units' prompt text (verse and hadith items out, figure descriptions out). */
  unitTexts: ReadonlyMap<string, string>;
  /** The engine's exercises block, per exercise slide, as the run selected it. */
  slideQuestions?: ReadonlyArray<Readonly<Record<string, number[]>>>;
  /** The latest run's pinned settlements. */
  settlements: GuideAnswerSettlementRecord[];
}

/** The latest run's settlements (a re-rolled run's are not the bound package's). */
export function latestRunSettlements(
  records: readonly GuideAnswerSettlementRecord[] | undefined,
): GuideAnswerSettlementRecord[] {
  if (!records || records.length === 0) return [];
  const run = Math.max(...records.map((record) => record.generationRun));
  return records.filter((record) => record.generationRun === run);
}

/**
 * Review finding 9: a run's settlements MERGED into what that run pinned before a pause
 * (never overwritten), each settlement once. Another run's records are dropped: a run
 * starts afresh only after the earlier one was discarded.
 */
export function mergeGuideSettlements(
  pinned: readonly GuideAnswerSettlementRecord[] | undefined,
  settled: readonly GuideAnswerSettlement[],
  run: number,
): GuideAnswerSettlementRecord[] {
  const merged = (pinned ?? []).filter((record) => record.generationRun === run);
  const seen = new Set(merged.map((record) => JSON.stringify(record)));
  for (const settlement of settled) {
    const record: GuideAnswerSettlementRecord = { ...settlement, generationRun: run };
    const key = JSON.stringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged;
}

/** Review finding 9: the outline ids THIS run's settlements dropped (attempts left empty). */
export function droppedGuideOutlineIds(
  records: readonly GuideAnswerSettlementRecord[] | undefined,
  run: number,
): Set<string> {
  return new Set(
    (records ?? [])
      .filter((record) => record.generationRun === run)
      .flatMap((record) => record.dropped),
  );
}

/** The exercise items a run removed from the lesson (they get no reviewer line). */
export function removedGuideItemKeys(
  records: readonly GuideAnswerSettlementRecord[] | undefined,
): Set<string> {
  return new Set(
    (records ?? []).flatMap((record) =>
      (record.items ?? []).filter((item) => item.outcome === 'removed').map(guideItemKey),
    ),
  );
}

/**
 * The package's guide context, or null (not g5.v11, no guide or no book map pinned).
 * `units` are the attempt's retained content units (full text, never the reviewer's
 * clipped copy), so the facts and the exercise selection are the run's.
 */
export function guideAnswerContextOf(input: {
  teachingModel: { key?: string | null; version?: string | null } | null | undefined;
  snapshot:
    | {
        teacherGuide?: KafuoTeacherGuide;
        bookStructure?: KafuoBookStructure;
        guideAnswerSettlements?: GuideAnswerSettlementRecord[];
      }
    | null
    | undefined;
  units: ReadonlyArray<{
    unitId: string;
    normalizedText: string;
    role?: string | null;
    subtype?: string | null;
  }>;
  language: string | null | undefined;
}): GuideAnswerContext | null {
  const guide = input.snapshot?.teacherGuide;
  // Lesson 2-5 (17 Nov 2026): the run's typed practice units («تأكد», a «تدرب» part).
  const book = withTypedPracticeUnits(
    input.snapshot?.bookStructure,
    input.units.map((unit) => ({
      id: String(unit.unitId),
      role: unit.role,
      subtype: unit.subtype,
    })),
  );
  if (!isGuideAnswerModel(input.teachingModel) || !guide || !book) return null;
  const facts = bookUnitFactsOf(
    book,
    input.units.map((unit) => ({ id: String(unit.unitId), text: unit.normalizedText })),
    // Lesson 2-5: the g5.v11 run's count of questions that share a book line.
    { inlineQuestions: true },
  );
  const sacred = new Set(
    book.units.filter(isSacredExerciseElement).map((unit) => String(unit.contentUnitId)),
  );
  // The run's `promptUnitText`: verse and hadith items out, then figure descriptions out.
  const unitTexts = new Map(
    input.units.map((unit) => {
      const id = String(unit.unitId);
      const text = sacred.has(id) ? withoutSacredItems(unit.normalizedText) : unit.normalizedText;
      return [id, stripProviderImageDescriptions(text, input.language)] as const;
    }),
  );
  const coverage = teacherParityBook(book, input.teachingModel, facts, guide);
  const slideQuestions = coverage?.teacherParity
    ? selectExercises(coverage, facts)?.slideQuestions
    : undefined;
  return {
    book,
    resolved: resolveTeacherGuide(guide, book, facts),
    facts,
    unitTexts,
    ...(slideQuestions ? { slideQuestions } : {}),
    settlements: latestRunSettlements(input.snapshot?.guideAnswerSettlements),
  };
}

/** The guard over a package's outline, its run's settlements restored. */
export function guideAnswerGuardFor(
  context: GuideAnswerContext,
  outlines: readonly SceneOutline[],
  onSettled?: (settlement: GuideAnswerSettlement) => void,
): GuideAnswerGuard {
  const guard = createGuideAnswerGuard({
    unitTexts: context.unitTexts,
    ...(onSettled ? { onSettled } : {}),
  });
  const plans = guideOutlinePlans(outlines, context.book, context.resolved, {
    ...(context.slideQuestions ? { slideQuestions: context.slideQuestions } : {}),
    facts: context.facts,
    unitTexts: context.unitTexts,
  });
  guard.usePlans(plans);
  guard.restore(context.settlements);
  // Owner (17 Nov 2026): the written attempts, minted exactly as the run minted them.
  guard.useWrittenAttempts(
    guideWrittenAttempts(outlines, plans, {
      guideId: context.resolved.guideId,
      unitTexts: context.unitTexts,
    }),
  );
  return guard;
}

/**
 * The agent read API's lesson parts (Kafuo Agent API plan §1.5, spec §5.6).
 * Pure: the route reads the coverage the editor's «أجزاء الدرس» reads
 * (`readContentUnitsForGrant`'s result), the Submit gate's essential sections
 * and the producing attempt's book map; this module maps them.
 *
 * `badge` and `can_generate` come from the SAME shared functions the editor
 * panel uses (`lib/edit/lesson-part-badge.ts`), so the two never disagree.
 */
import { canGenerateForUnit, unitBadge } from '@/lib/edit/lesson-part-badge';
import { exerciseQuestionNumbers } from '@/lib/server/teaching-package/hidden-step-types';
import type { UnitCoverage } from '@/lib/server/teaching-package/content-unit-coverage';
import type { KafuoBookStructureUnit } from '@/lib/types/teaching-package';

export type AgentPartBadge = 'covered' | 'quiz_only' | 'no_slide' | 'reference';

export interface AgentPart {
  part_id: string;
  order: number;
  title: string | null;
  content_unit_id: string;
  role: string;
  subtype: string | null;
  /** Null when the version records no Submit coverage authority (older packages). */
  essential: boolean | null;
  /** Null when the producing attempt carried no book map. */
  exercise: boolean | null;
  exercise_count: number | null;
  badge: AgentPartBadge;
  taught_by_scene_ids: string[];
  cited_by_other_scene_ids: string[];
  can_generate: boolean;
  /** Not known to the Teaching Engine (no page on a Content Unit row); the backend fills it. */
  book_pages: null;
}

const BADGE: Record<ReturnType<typeof unitBadge>, AgentPartBadge> = {
  covered: 'covered',
  'quiz-only': 'quiz_only',
  'no-slide': 'no_slide',
  reference: 'reference',
};

export interface ProjectPartsInput {
  units: ReadonlyArray<UnitCoverage & { subtype?: string | null; text?: string | null }>;
  /** The Submit gate's essential sections; null = no recorded authority. */
  essentialUnitIds: readonly string[] | null;
  /** The producing attempt's book map units; null = none recorded. */
  bookUnits: readonly KafuoBookStructureUnit[] | null;
}

/**
 * `exercise` = the book map makes the unit an `exercise` element. Its count is
 * the numbered questions in its retained text (`exerciseQuestionNumbers`, the
 * rule the run pins as `bookUnitFacts.questionNumbers`); a unit without numbered
 * questions weighs one, as in the engine's exercise selection.
 */
export function projectAgentParts(input: ProjectPartsInput): AgentPart[] {
  const essential = input.essentialUnitIds ? new Set(input.essentialUnitIds) : null;
  const book = input.bookUnits
    ? new Map(input.bookUnits.map((unit) => [unit.contentUnitId, unit]))
    : null;
  return input.units.map((unit) => {
    const exercise = book ? book.get(unit.id)?.element === 'exercise' : null;
    return {
      part_id: unit.id,
      order: unit.order,
      title: unit.title,
      content_unit_id: unit.id,
      role: unit.role,
      subtype: unit.subtype ?? null,
      essential: essential ? essential.has(unit.id) : null,
      exercise,
      exercise_count: exercise
        ? Math.max(1, exerciseQuestionNumbers(unit.text ?? '').length)
        : null,
      badge: BADGE[unitBadge(unit)],
      taught_by_scene_ids: [...unit.coveredBySlideIds],
      cited_by_other_scene_ids: [...unit.citedByOtherSceneIds],
      can_generate: canGenerateForUnit(unit),
      book_pages: null,
    };
  });
}

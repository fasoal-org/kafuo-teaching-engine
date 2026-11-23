/**
 * The "Lesson parts" badge and "Generate slide" rules, shared by the editor's
 * LessonPartsPanel and the agent read API (Kafuo Agent API plan §1.5, A3), so
 * the API and the editor never disagree. Pure and server-safe: no React, no
 * client or server imports — both `UnitCoverage` (server) and
 * `ContentUnitSummary` (client) fit the structural input.
 */
export type UnitBadge = 'covered' | 'quiz-only' | 'no-slide' | 'reference';

export interface LessonPartBadgeInput {
  instructional: boolean;
  covered: boolean;
  citedByOtherSceneIds: readonly string[];
  textLength: number;
}

/** Plan §8.2: covered = a live slide cites it; "quiz only" = cited only by other scenes. */
export function unitBadge(unit: Omit<LessonPartBadgeInput, 'textLength'>): UnitBadge {
  if (!unit.instructional) return 'reference';
  if (unit.covered) return 'covered';
  if (unit.citedByOtherSceneIds.length > 0) return 'quiz-only';
  return 'no-slide';
}

/** A slide can be generated for it: instructional, with retained text, no live slide. */
export function canGenerateForUnit(
  unit: Pick<LessonPartBadgeInput, 'instructional' | 'covered' | 'textLength'>,
): boolean {
  return unit.instructional && !unit.covered && unit.textLength > 0;
}

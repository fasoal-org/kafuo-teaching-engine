import type { SceneOutline } from '@/lib/types/generation';

/**
 * Content Unit ids are the planner's citations, never learner text.
 *
 * The g5.v8 exercises block tells the planner which units each exercise slide
 * solves («exercise slide 1 solves the units 4386 (questions 1–3 only), …»),
 * and the planner sometimes copies that id into a key point as a label
 * («4386 | التكلفة والمواعيد …»). The scene generator then prints it on the
 * slide (staging lesson 426, 4 Nov 2026: «٤٣٨٦ |» on the exercises slide).
 *
 * Instructions alone do not stop a model from doing this, so the final plan is
 * cleaned before any Scene is generated: a label is removed only when its number
 * is one of this lesson's Content Unit ids, so a number the lesson teaches stays.
 */

const DIGITS = '0-9٠-٩۰-۹';
/** «4386 |», «(4386) |», «٤٣٨٦ |», after the start of the text or a separator. */
const PIPE_LABEL = new RegExp(`(^|[\\s(،,؛;])\\(?([${DIGITS}]{2,})\\)?\\s*[|｜]\\s*`, 'g');
/** «4386: …», «4386 - …» as the very start of a key point or title. */
const LEADING_LABEL = new RegExp(`^\\s*\\(?([${DIGITS}]{2,})\\)?\\s*[:：\\-–—]\\s+`);

function latinDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function stripLabels(text: string, unitIds: ReadonlySet<string>): string {
  const withoutPipes = text.replace(PIPE_LABEL, (match, lead: string, id: string) =>
    unitIds.has(latinDigits(id)) ? lead : match,
  );
  return withoutPipes.replace(LEADING_LABEL, (match, id: string) =>
    unitIds.has(latinDigits(id)) ? '' : match,
  );
}

/**
 * The plan with every Content Unit id label removed from the learner-visible
 * fields (title, description, key points, teaching objective). Outlines with no
 * such label are returned unchanged (same object).
 */
export function stripContentUnitIdLabels(
  outlines: SceneOutline[],
  contentUnitIds: Iterable<string | number>,
): SceneOutline[] {
  const ids = new Set([...contentUnitIds].map((id) => latinDigits(String(id))));
  if (ids.size === 0) return outlines;
  return outlines.map((outline) => {
    const title = stripLabels(outline.title, ids);
    const description = stripLabels(outline.description, ids);
    const keyPoints = outline.keyPoints.map((point) => stripLabels(point, ids));
    const teachingObjective =
      outline.teachingObjective === undefined
        ? undefined
        : stripLabels(outline.teachingObjective, ids);
    const changed =
      title !== outline.title ||
      description !== outline.description ||
      keyPoints.some((point, index) => point !== outline.keyPoints[index]) ||
      teachingObjective !== outline.teachingObjective;
    if (!changed) return outline;
    return {
      ...outline,
      title,
      description,
      keyPoints,
      ...(teachingObjective === undefined ? {} : { teachingObjective }),
    };
  });
}

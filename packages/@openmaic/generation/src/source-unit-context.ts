/**
 * The approved textbook text a teaching slide is grounded in, for its content
 * and narration prompts.
 *
 * The outline already names the Content Units each slide teaches
 * (`sourceContentUnitIds`); without this, Scene generation saw only the
 * outline's title, key points and planner note, so definitions, reasoning and
 * worked-example steps could be lost between the textbook and the slide.
 *
 * - Only the units THIS slide cites, in the order it cites them — never the
 *   whole lesson, never a unit another slide cites.
 * - Only teaching slides: a check or practice slide keeps its answer boundary
 *   (its source would hand the model the solution it must not reveal), and an
 *   introduction or recap does not need the full text.
 * - Bounded: at most {@link MAX_SCENE_SOURCE_CHARS} characters per slide. A
 *   cut is stated in the prompt and reported to the caller — never silent.
 * - No ids or markers: unit titles only, so nothing internal can be echoed
 *   into slide text or speech (`findInternalLeaks`).
 *
 * Absent `sourceUnits` → `{ hasSourceContext: false }` and every prompt
 * renders byte-identically to before.
 */
import type { SceneOutline } from './outline-types.js';

/** One approved Content Unit's text, as the caller retained it. */
export interface SourceUnitText {
  id: string;
  title?: string | null;
  text: string;
}

/** Per-slide budget for source text (characters), shared by content and narration. */
export const MAX_SCENE_SOURCE_CHARS = 12_000;

/** Slide roles that teach their cited units; a slide with no role yet also qualifies. */
const SOURCE_CONTEXT_ROLES: ReadonlySet<string> = new Set([
  'explanation',
  'example',
  'worked_example',
  'procedure',
]);

export interface SceneSourceContext {
  hasSourceContext: boolean;
  sourceContextText: string;
  /** Units (ids) that did not fit the budget in full; empty when nothing was cut. */
  clippedUnitIds: string[];
}

const NONE: SceneSourceContext = {
  hasSourceContext: false,
  sourceContextText: '',
  clippedUnitIds: [],
};

export function buildSceneSourceContext(
  outline: Pick<SceneOutline, 'type' | 'contentRole' | 'sourceContentUnitIds'>,
  sourceUnits: readonly SourceUnitText[] | undefined,
): SceneSourceContext {
  if (!sourceUnits?.length || outline.type !== 'slide') return NONE;
  if (outline.contentRole && !SOURCE_CONTEXT_ROLES.has(outline.contentRole)) return NONE;
  const byId = new Map(sourceUnits.map((unit) => [String(unit.id), unit]));
  const cited = [...new Set((outline.sourceContentUnitIds ?? []).map(String))]
    .map((id) => byId.get(id))
    .filter((unit): unit is SourceUnitText => !!unit && unit.text.trim() !== '');
  if (cited.length === 0) return NONE;

  let budget = MAX_SCENE_SOURCE_CHARS;
  const sections: string[] = [];
  const clippedUnitIds: string[] = [];
  for (const [index, unit] of cited.entries()) {
    const heading = `Source section ${index + 1}${unit.title?.trim() ? `: ${unit.title.trim()}` : ''}`;
    const text = unit.text.trim();
    if (budget <= 0) {
      clippedUnitIds.push(String(unit.id));
      sections.push(`${heading}\n[not shown: the source for this slide exceeds the length limit]`);
      continue;
    }
    if (text.length > budget) {
      clippedUnitIds.push(String(unit.id));
      sections.push(
        `${heading}\n${text.slice(0, budget)}\n[the rest of this section is not shown: length limit]`,
      );
      budget = 0;
      continue;
    }
    sections.push(`${heading}\n${text}`);
    budget -= text.length;
  }
  return { hasSourceContext: true, sourceContextText: sections.join('\n\n'), clippedUnitIds };
}

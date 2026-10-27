/**
 * Stage-1 outline grounding gate for Kafuo normalized runs.
 *
 * The approved Content Unit is the pedagogical authority sent to the model, so
 * Content-Unit citation is the only grounding the model is asked for and the
 * only one checked here. Document Blocks stay internal: `adaptNormalizedText`
 * never renders one, the prompt never names one, and nothing below looks for
 * one.
 *
 * This runs on the outlines the model just returned — BEFORE a Stage is
 * reserved, before Scene content generation, before media. The check used to
 * run after `generateClassroom` had produced and persisted all 33 Scenes, so a
 * response that was ungrounded in its first outline still cost a full
 * generation (~5 minutes) before anyone found out.
 */
import { createLogger } from '@/lib/logger';
import { retainableUnitText } from '@/lib/server/teaching-package/content-units';
import type { NormalizedLessonManifest } from '@/lib/server/teaching-package/normalized-content-resource';
import type { SceneOutline } from '@/lib/types/generation';

const log = createLogger('TeachingPackageGeneration');

/**
 * A *model output* error, deliberately NOT
 * `NORMALIZED_CONTENT_LINEAGE_MISMATCH`: that code is reserved for a genuine
 * package/request lineage mismatch, and reporting a bad answer under it sent
 * the last diagnosis hunting a package that was provably correct.
 */
export const OUTLINE_GROUNDING_ERROR_CODE = 'OUTLINE_CONTENT_UNIT_GROUNDING_INVALID';

export interface UngroundedOutline {
  index: number;
  reasons: string[];
}

/**
 * Ids are compared as strings on both sides.
 *
 * The manifest carries ids as strings, but the projection shows the model bare,
 * unquoted values — `[[CONTENT_UNIT id=2900]]` — and asks it to copy them
 * "exactly". A model doing exactly that emits JSON *numbers*, and
 * `new Set(['2900']).has(2900)` is false, so a faithful citation failed this
 * gate for every outline at once. The declared type is `string[]`, but nothing
 * validates the model's response against it, so the type is a hope rather than
 * a guarantee — normalizing here is what makes the comparison mean what it says.
 */
const asKey = (id: unknown): string => String(id);

/** The Content Unit ids a model may legitimately cite for this package. */
export function manifestContentUnitIds(manifest: NormalizedLessonManifest): Set<string> {
  return new Set(manifest.contentUnits.map((unit) => asKey(unit.id)));
}

/**
 * Content Unit roles that carry the lesson's own instruction: a plan that
 * leaves one of them without a teaching slide has dropped a whole section of
 * the approved textbook. Every other role (checks, practice, summary,
 * activity, source material, reference, unclassified) may legitimately be
 * folded into a quiz, a recap or another slide, so none of them is required —
 * requiring them would fail plans that are pedagogically fine.
 */
export const ESSENTIAL_CONTENT_UNIT_ROLES: ReadonlySet<string> = new Set([
  'CONCEPT_EXPLANATION',
  'WORKED_EXAMPLE',
  'PROCEDURE',
]);

/**
 * Slide roles that do not teach a section: an introduction, a recap or a
 * check citing a unit is no evidence the unit itself was taught.
 */
const NON_TEACHING_SLIDE_ROLES: ReadonlySet<string> = new Set([
  'orientation',
  'summary',
  'check_understanding',
  'practice',
]);

/**
 * The essential sections of an approved manifest, in source order: units with
 * an essential role and usable text (the same text rule the prompt projection
 * uses, so a unit the model never read is never required) that the approved
 * structure did not exclude block by block.
 */
export function essentialContentUnitIds(manifest: NormalizedLessonManifest): string[] {
  return [...manifest.contentUnits]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .filter((unit) => {
      if (!ESSENTIAL_CONTENT_UNIT_ROLES.has(unit.role?.toUpperCase())) return false;
      if (!retainableUnitText(unit)) return false;
      const blocks = unit.blocks ?? [];
      return !(blocks.length > 0 && blocks.every((block) => block.disposition === 'excluded'));
    })
    .map((unit) => asKey(unit.id));
}

/**
 * Essential unit ids no teaching outline cites, in the order given. A quiz
 * outline, or a slide whose role is introduction/recap/check, does not count.
 * A slide with no role yet counts: classification is judged by its own gate,
 * and this check only catches a section the plan never teaches at all.
 */
export function findUncoveredContentUnits(
  outlines: readonly SceneOutline[],
  essentialIds: readonly string[],
): string[] {
  const taught = new Set<string>();
  for (const outline of outlines) {
    if (outline.type === 'quiz') continue;
    if (outline.contentRole && NON_TEACHING_SLIDE_ROLES.has(outline.contentRole)) continue;
    for (const id of outline.sourceContentUnitIds ?? []) taught.add(asKey(id));
  }
  return essentialIds.filter((id) => !taught.has(asKey(id)));
}

/** Per-outline grounding faults, in outline order. Empty → every outline is grounded. */
export function findUngroundedOutlines(
  outlines: SceneOutline[],
  unitIds: Set<string>,
): UngroundedOutline[] {
  return outlines
    .map((outline, index) => {
      const units = Array.isArray(outline.sourceContentUnitIds)
        ? outline.sourceContentUnitIds.map(asKey)
        : null;
      const reasons: string[] = [];
      if (units === null) reasons.push('sourceContentUnitIds missing');
      else if (units.length === 0) reasons.push('sourceContentUnitIds empty');
      const unknown = (units ?? []).filter((id) => !unitIds.has(id));
      if (unknown.length > 0)
        reasons.push(`unknown content units: ${unknown.slice(0, 5).join(', ')}`);
      return reasons.length > 0 ? { index, reasons } : null;
    })
    .filter((entry): entry is UngroundedOutline => entry !== null);
}

/**
 * Throw `OUTLINE_CONTENT_UNIT_GROUNDING_INVALID` unless every outline cites at
 * least one Content Unit id that exists in the approved manifest.
 */
export function assertOutlineContentUnitGrounding(
  outlines: SceneOutline[],
  manifest: NormalizedLessonManifest,
  attemptId: string,
  run: number,
): void {
  const unitIds = manifestContentUnitIds(manifest);
  const ungrounded = findUngroundedOutlines(outlines, unitIds);
  if (ungrounded.length === 0) {
    // Accepting a numeric id must not persist one. The declared type is
    // `string[]`, and everything downstream — persistence, the Editor-save
    // merge, successor cloning — carries this value onward untouched, so the
    // gate is the one place that can make the declaration true. Writing back
    // here is also why this runs before the Stage is reserved: the outlines
    // persisted later are these same objects.
    for (const outline of outlines) {
      if (Array.isArray(outline.sourceContentUnitIds))
        outline.sourceContentUnitIds = outline.sourceContentUnitIds.map(asKey);
    }
    return;
  }

  // Logged before throwing, with the offending values and a sample of what was actually
  // on offer. Diagnosing this from the stored attempt was impossible: the outlines are
  // discarded by the run's compensation and only `{step, message, scenesGenerated}`
  // survives, so "missing or unrecognized" was the whole of the evidence.
  log.warn(
    `Teaching package attempt ${attemptId} run ${run} rejected outline grounding: ` +
      `${ungrounded.length}/${outlines.length} outlines ungrounded ` +
      `[${ungrounded
        .slice(0, 5)
        .map((entry) => `#${entry.index}: ${entry.reasons.join('; ')}`)
        .join(' | ')}]; ` +
      `manifest offered ${unitIds.size} content units ` +
      `(e.g. ${[...unitIds].slice(0, 3).join(', ')})`,
  );
  const error = new Error(
    'outline content-unit grounding is missing or unrecognized; no scenes were generated',
  );
  Object.assign(error, { code: OUTLINE_GROUNDING_ERROR_CODE });
  throw error;
}

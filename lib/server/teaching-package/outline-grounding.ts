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

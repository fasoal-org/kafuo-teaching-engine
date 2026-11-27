/**
 * g5.v12 (critical items before package regeneration, 27 Nov 2026: QZ-4): every number a
 * slide shows is checked against the book text of the units it cites.
 *
 * A TE analogue of the backend's S4 source comparator (S4-02 is Python, over the source
 * text; nothing of it runs in the engine): the same digit and number reading as the guide
 * answers (`guideNumbers`, Arabic-Indic digits, decimal commas, fractions), applied to a
 * generated slide's canvas against its cited units' text.
 *
 * - Judged: a slide that teaches from its cited text — an explanation, an example, a
 *   procedure, or a try-it slide (its book question). Never a solution slide
 *   (`worked_example`): it computes values the book does not print. Never a slide that
 *   cites no unit with text.
 * - A finding is a number on the canvas (a value, not a date, page, reference or item
 *   label) that equals no number of the cited text. An equation is checked through its
 *   numbers only. Whole numbers 0–10 are not judged: list steps and ordinals use them
 *   (a known blind spot).
 * - It is a RECORD for the reviewer (`slideNumberFindings` on the attempt), never a gate:
 *   its false-positive rate is unmeasured until a staging run (the owner decides then).
 */
import { guideNumbers, numbersAgree } from '@/lib/server/teaching-package/guide-answer-compare';
import { canvasLines } from '@/lib/server/teaching-package/guide-answer-guard';

/** The slide roles judged: those that teach from (or set) their cited text. */
const JUDGED_ROLES: ReadonlySet<string> = new Set([
  'explanation',
  'example',
  'procedure',
  'check_understanding',
]);

/** A whole number this small is a step, an ordinal or a count: not judged. */
const SMALL_WHOLE = 10;

export interface SlideNumberFinding {
  sceneId: string;
  outlineId: string | null;
  title: string;
  /** The canvas numbers no cited unit prints (at most 8). */
  numbers: number[];
}

interface SceneLike {
  id: string;
  outlineId?: string | null;
  title?: string;
  type: string;
  content?: unknown;
  sourceContentUnitIds?: readonly string[] | null;
}

function values(text: string): number[] {
  return guideNumbers(text)
    .filter((token) => token.kind === 'value')
    .map((token) => token.value);
}

/** The slides whose canvas shows a number their cited book text does not print. */
export function slideNumberFindings(
  scenes: readonly SceneLike[],
  unitTexts: ReadonlyMap<string, string>,
): SlideNumberFinding[] {
  const findings: SlideNumberFinding[] = [];
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const role = (scene.content as { contentRole?: unknown } | undefined)?.contentRole;
    if (typeof role !== 'string' || !JUDGED_ROLES.has(role)) continue;
    const texts = (scene.sourceContentUnitIds ?? [])
      .map((id) => unitTexts.get(String(id)) ?? '')
      .filter((text) => text.trim() !== '');
    if (texts.length === 0) continue;
    const book = texts.flatMap(values);
    const unknown: number[] = [];
    for (const line of canvasLines(scene.content)) {
      for (const value of values(line)) {
        if (Number.isInteger(value) && Math.abs(value) <= SMALL_WHOLE) continue;
        if (book.some((printed) => numbersAgree(printed, value, 1e-9))) continue;
        if (!unknown.some((seen) => seen === value)) unknown.push(value);
      }
    }
    if (unknown.length > 0) {
      findings.push({
        sceneId: scene.id,
        outlineId: scene.outlineId ?? null,
        title: scene.title ?? '',
        numbers: unknown.slice(0, 8),
      });
    }
  }
  return findings;
}

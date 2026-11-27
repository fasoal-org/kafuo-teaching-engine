/**
 * g5.v12 book-part placement (plan `docs/frds/book-section-order-fix-plan-2026-11-25.md`,
 * owner 25 Nov 2026): "the slides do not match the book ordering … link the slide with the
 * lesson part, not with the goals".
 *
 * The Kafuo backend already sends, per objective, the book parts it owns in book order
 * (`learningObjectives[].contentUnitIds`; `book_structure.py` refuses a mapping where a
 * later objective owns an earlier part, so each objective owns a run of consecutive
 * parts). Until g5.v12 that list reached only the request digest: the planner saw the
 * objective statements and guessed where each part goes.
 *
 * Pure pieces, all g5.v12 only ({@link isBookPartPlacementModel} at the callers):
 *
 * 1. {@link bookPartsRequirement}: the planner is given the parts in book order, each
 *    with its units and the objective block (flow position) it belongs to.
 * 2. {@link placeOutlinesByBookPart}: before any Scene is generated, the engine puts
 *    every teaching slide in book order, inside the objective block that owns its part.
 *    Structural slides follow the part they open; the exercises block and the closing
 *    slide stay at the end of their block; anything else follows the slide before it.
 *    An objective's check quiz is re-grounded on what its block now teaches.
 * 3. {@link placeWithGuard}: the placement is kept only when a re-diagnosis finds no
 *    issue (or more of one) that the planned order did not have.
 *
 * The objectives stay as the labels of the blocks, so each objective's graded checks
 * still come after its last part (owner decision A, 25 Nov 2026). Nothing here logs
 * lesson text.
 *
 * Critical items before regeneration (27 Nov 2026, planner review W1.3–W1.5 and
 * book-section plan W3), all g5.v12 only:
 *
 * 4. Every unit with a `partIndex` is part content, a kind-less one too (D-4, W1.5):
 *    {@link isPartUnit}. Before, an allowlist dropped the units the template could not
 *    name, so their text was left unordered and could be taught out of place or dropped.
 * 5. A slide citing checks is placed by its LAST check, a try-it too (W1.3): a try-it
 *    merged from two parts is never asked before the second part is taught.
 * 6. {@link findBookOrderDiagnostics}: the order gate (W1.4 / W3). A teaching slide that
 *    sits outside the block owning its part, or after a slide the book prints later, is
 *    `admin_correctable`; a check asked before the units the book prints before it in its
 *    own part is reported as such. It runs in the one outline diagnosis, so the placement
 *    runs first and what it cannot fix fails closed.
 */
import type { OutlineDiagnostic } from '@openmaic/generation';
import {
  findBookCoverageGaps,
  isBookPartPlacementModel,
  type CoverageBookStructure,
} from '@/lib/server/teaching-package/book-coverage';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationCheckpointLogEntry,
  GenerationInputSnapshot,
  KafuoBookStructure,
  KafuoBookStructureUnit,
  LearningObjectiveRef,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

/** The per-objective explanation position of every g5 flow (one per objective, in order). */
export const OBJECTIVE_EXPLANATION_STAGE = 'outcome_visual_explanations';
/** The per-objective check quiz position, right after the objective's explanation block. */
export const OBJECTIVE_CHECK_STAGE = 'outcome_check_understanding';

/** The elements the engine places by their own rule, never by part. */
const PLACED_BY_RULE: ReadonlySet<string> = new Set([
  'prior_knowledge',
  'exercise',
  'objective_source',
  'ignore',
]);

/**
 * Whether a unit is part content: it lies in a lesson part and the engine does not place
 * it by its own rule. Recall, exercises, objective sources and ignored units are not. A
 * kind-less unit is (D-4, W1.5): the text the book prints after a check continues the
 * part's explanation, and dropping it left it unordered. An untyped practice unit is
 * typed as an exercise before the map is built (the typed book), so it stays out.
 */
export function isPartUnit(unit: Pick<KafuoBookStructureUnit, 'partIndex' | 'element'>): boolean {
  return unit.partIndex !== undefined && !PLACED_BY_RULE.has(String(unit.element));
}

const STRUCTURAL_SLIDE_TYPES: ReadonlySet<string> = new Set(['cover', 'contents', 'transition']);

/** How many key points a re-grounded check quiz keeps (one or more from each slide). */
const MAX_QUIZ_KEY_POINTS = 8;

interface PlacedUnit {
  id: string;
  /** Book order: the unit's index in `bookStructure.units`. */
  position: number;
  partIndex: number;
  /** The flow position of the objective block that owns the unit's part. */
  flowIndex: number;
  element: string | null;
}

export interface BookPart {
  partIndex: number;
  /** The flow position of the objective block that owns this part. */
  flowIndex: number;
  objectiveRef: string;
  /** The part's units the planner teaches, in book order. */
  unitIds: string[];
}

export interface BookPartMap {
  units: ReadonlyMap<string, PlacedUnit>;
  /** The lesson's parts in book order. */
  parts: readonly BookPart[];
  /** The objective blocks' flow positions, in objective order. */
  blocks: readonly number[];
  /** Each block's objective statement (by the block's flow position). */
  statements: ReadonlyMap<number, string>;
  /** The book's exercise units (the exercises block, placed by rule). */
  exerciseUnitIds: ReadonlySet<string>;
}

/**
 * The parts of the lesson and the block each belongs to, or `null` when the request
 * cannot carry them: no book map, an objective without its unit list, a flow whose
 * objective blocks do not match the objectives one for one, or a part split between two
 * objectives (the backend never sends one). Every part unit is in it (D-4, W1.5), a
 * kind-less one too, when an objective owns it.
 */
export function buildBookPartMap(
  book: KafuoBookStructure | undefined,
  objectives: readonly LearningObjectiveRef[],
  flow: readonly TeachingFlowEntry[],
): BookPartMap | null {
  if (!book || objectives.length === 0) return null;
  const blocks = flow.flatMap((entry, index) =>
    entry.stage === OBJECTIVE_EXPLANATION_STAGE ? [index] : [],
  );
  if (blocks.length !== objectives.length) return null;

  const ownerOf = new Map<string, number>();
  for (const [index, objective] of objectives.entries()) {
    if (!objective.contentUnitIds) return null;
    for (const id of objective.contentUnitIds) {
      if (!ownerOf.has(String(id))) ownerOf.set(String(id), index);
    }
  }

  const units = new Map<string, PlacedUnit>();
  const parts: BookPart[] = [];
  const exerciseUnitIds = new Set<string>();
  for (const [position, unit] of book.units.entries()) {
    const id = String(unit.contentUnitId);
    const partIndex = unit.partIndex;
    if (unit.element === 'exercise') exerciseUnitIds.add(id);
    if (partIndex === undefined || !isPartUnit(unit)) continue;
    const owner = ownerOf.get(id);
    if (owner === undefined) continue;
    const flowIndex = blocks[owner]!;
    units.set(id, { id, position, partIndex, flowIndex, element: unit.element });
    let part = parts.find((entry) => entry.partIndex === partIndex);
    if (!part) {
      part = {
        partIndex,
        flowIndex,
        objectiveRef: objectives[owner]!.objectiveRef,
        unitIds: [],
      };
      parts.push(part);
    }
    if (part.flowIndex !== flowIndex) return null;
    part.unitIds.push(id);
  }
  if (parts.length === 0) return null;
  const statements = new Map(
    blocks.map((flowIndex, index) => [flowIndex, objectives[index]!.snapshot.statement] as const),
  );
  return { units, parts, blocks, statements, exerciseUnitIds };
}

/**
 * The parts map of a g5.v12 request, or `null` on every other Teaching Model (and on
 * the cases {@link buildBookPartMap} refuses). The one place the identity check is made
 * for a diagnosis, an edit or a resume.
 */
export function bookPartMapFor(
  teachingModel: { key?: string | null; version?: string | null } | null | undefined,
  book: KafuoBookStructure | undefined,
  objectives: readonly LearningObjectiveRef[] | undefined,
  flow: readonly TeachingFlowEntry[],
): BookPartMap | null {
  return isBookPartPlacementModel(teachingModel)
    ? buildBookPartMap(book, objectives ?? [], flow)
    : null;
}

/**
 * Every unit the parts list names, in book order (D-4): the units the plan must teach on
 * a slide of their own part, a kind-less one too.
 */
export function listedPartUnitIds(map: BookPartMap): string[] {
  return map.parts.flatMap((part) => part.unitIds);
}

/**
 * The listed part units no teaching slide of its own cites, in book order (EN-8: such a
 * unit is never skipped silently). Read with the coverage gate's own rule, so a unit the
 * gate counts as untaught — also an idea cited only on a check's try-it or solution
 * slide on g5.v12 — is one of them. The plan can reach a Scene with such a unit only
 * when a person accepted the finding; it is then named here for the record.
 */
export function untaughtListedPartUnits(
  outlines: readonly SceneOutline[],
  map: BookPartMap,
  book: CoverageBookStructure,
): string[] {
  const untaught = new Set(
    findBookCoverageGaps(outlines, book)
      .filter((gap) => gap.kind === 'missing_teaching')
      .map((gap) => gap.unit.contentUnitId),
  );
  return listedPartUnitIds(map).filter((id) => untaught.has(id));
}

/**
 * The v12 rules the planner is held to (27 Nov 2026). Each one is a gate the engine
 * checks on the plan, or fixes itself, before any slide is generated.
 */
const BOOK_PART_RULES: readonly string[] = [
  'g5.v12 RULES (the engine checks each one before any slide is generated):',
  '- EVERY LISTED UNIT IS TAUGHT: each unit listed above gets its own teaching slide, in',
  '  its part and in book order. A unit the template names no kind for continues the',
  '  explanation before it: teach it too, on its own slide, where the book prints it.',
  '- ONE IDEA PER SLIDE: a teaching slide teaches ONE listed unit. Never two key concepts',
  '  on one slide, and never a key-concept box together with an example. A side note (a',
  '  supporting unit) stays on the slide of the element it explains.',
  '- ONE CHECK PER SLIDE: a try-it slide (contentRole check_understanding) sets the items',
  '  of ONE check unit, and its solution slide (contentRole worked_example) solves that',
  '  one check. Never merge two checks on one slide, and never checks of two parts.',
  '- NO CHECK BEFORE ITS PART: a check is asked only after every slide that teaches a',
  '  unit the book prints before that check in its part.',
  '- NO TITLE-ONLY SLIDE: plan no transition slide that holds only a title and one line.',
  '  The first teaching slide of each part names the part in its title.',
];

/**
 * The planner text: the parts in book order, each with its units and the objective block
 * its slides must carry, then the rules above. Given to a g5.v12 planner only.
 */
export function bookPartsRequirement(map: BookPartMap, flow: readonly TeachingFlowEntry[]): string {
  return [
    '',
    'LESSON PARTS IN BOOK ORDER (authoritative). The lesson follows the book part by part,',
    "never the objectives' wording. Each part belongs to exactly one objective block: plan",
    "the part's slides inside that block, copying the block's teachingStage exactly, in the",
    "order below, and never teach a part's units in another block. Within a part, follow",
    "the book's own order of its units. Exercises, the closing slide and the opening slides",
    'keep their own rules.',
    ...map.parts.map(
      (part) =>
        `- Part ${part.partIndex} → teachingStage { "key": "${flow[part.flowIndex]!.stage}", "flowIndex": ${part.flowIndex} } (objective [${part.objectiveRef}]): units ${part.unitIds.join(', ')}`,
    ),
    ...BOOK_PART_RULES,
  ].join('\n');
}

interface Placement {
  flowIndex: number;
  /** 0 lead, 1 the parts in book order, 2 the block's tail (exercises, closing). */
  group: 0 | 1 | 2;
  key: number;
  /** At one key a try-it slide (0) comes before a solution or any other slide (1)… */
  rank: 0 | 1;
  /** …ties keep the planned order of the slides that own them… */
  tie: number;
  /** …and a slide that follows another stays right behind it. */
  sub: number;
}

/** A teaching slide's place in book order, read from the units it cites. */
export interface SlidePlacement {
  /** The unit that places the slide: its last check, else its earliest unit. */
  anchor: PlacedUnit;
  /** The checks it cites, in book order. */
  checks: PlacedUnit[];
  /** Every cited unit the map places. */
  cited: PlacedUnit[];
  /** Its units belong to two objective blocks. */
  mixed: boolean;
}

/**
 * A teaching slide's place: by the checks it sets when it cites one, else its earliest
 * unit. A slide citing checks takes its LAST check, a try-it too (W1.3: it took its
 * first, so a try-it merged from two parts was asked before the second part was
 * taught). So no slide that cites a check ever comes before the try-it of that check,
 * even when it also cites the example before it.
 */
function placementOf(outline: SceneOutline, map: BookPartMap): SlidePlacement | null {
  if (outline.type !== 'slide' || STRUCTURAL_SLIDE_TYPES.has(String(outline.slideType ?? ''))) {
    return null;
  }
  const cited = (outline.sourceContentUnitIds ?? [])
    .map((id) => map.units.get(String(id)))
    .filter((unit): unit is PlacedUnit => unit !== undefined);
  if (cited.length === 0) return null;
  const checks = cited.filter((unit) => unit.element === 'try_it');
  const pool = checks.length > 0 ? checks : cited;
  const last = checks.length > 0;
  const anchor = pool.reduce((chosen, unit) =>
    (last ? unit.position > chosen.position : unit.position < chosen.position) ? unit : chosen,
  );
  return {
    anchor,
    checks,
    cited,
    mixed: new Set(cited.map((unit) => unit.flowIndex)).size > 1,
  };
}

function teachingPlacement(
  outline: SceneOutline,
  map: BookPartMap,
): { flowIndex: number; key: number; mixed: boolean } | null {
  const place = placementOf(outline, map);
  return place
    ? { flowIndex: place.anchor.flowIndex, key: place.anchor.position, mixed: place.mixed }
    : null;
}

/** The exercises block and the closing slide: kept at the end of their own block. */
function isBlockTail(
  outline: SceneOutline,
  next: SceneOutline | undefined,
  map: BookPartMap,
): boolean {
  if (outline.slideType === 'end' || outline.contentRole === 'summary') return true;
  const solvesExercises = (candidate: SceneOutline | undefined) => {
    const ids = (candidate?.sourceContentUnitIds ?? []).map(String);
    // Any exercise cited makes an exercise slide, as the teacher-parity gate counts it.
    return ids.some((id) => map.exerciseUnitIds.has(id));
  };
  if (solvesExercises(outline)) return true;
  // The «تمارين» transition opens the exercises block.
  return outline.slideType === 'transition' && solvesExercises(next);
}

/**
 * g5.v12 (W1.4, book-section plan W3): a teaching slide outside the book's order — it
 * sits in another objective's block than the one owning its part, it comes after a slide
 * the book prints later, or its units belong to two blocks.
 */
export const SLIDE_OUT_OF_BOOK_ORDER = 'SLIDE_OUT_OF_BOOK_ORDER';
/**
 * g5.v12 (W1.3): a check asked before the slides that teach the units the book prints
 * before it in the check's own part.
 */
export const CHECK_BEFORE_ITS_PART = 'CHECK_BEFORE_ITS_PART';

/** `unit 6772 (part 5)`: an id and its part, never a title or text. */
const unitLabel = (unit: PlacedUnit) => `unit ${unit.id} (part ${unit.partIndex})`;

/**
 * The order gate of a g5.v12 plan: every teaching slide inside the block that owns its
 * part, and in book order inside it (a try-it before the solution of its check). At one
 * key the try-it (rank 0) comes first and any other slide (rank 1) after it, exactly as
 * {@link placeOutlinesByBookPart} sorts. The closing slide, the exercises block and a
 * slide citing no unit of the map are placed by rule and never reported.
 *
 * A slide the placement could not put right is reported once: a try-it that precedes a
 * slide teaching an earlier unit of its own part as {@link CHECK_BEFORE_ITS_PART} (the
 * check is what came too early), any other late slide as {@link SLIDE_OUT_OF_BOOK_ORDER},
 * with the block it belongs to. A slide cannot be in two findings.
 */
export function findBookOrderDiagnostics(
  outlines: readonly SceneOutline[],
  map: BookPartMap,
  flow: readonly TeachingFlowEntry[],
): OutlineDiagnostic[] {
  const diagnostics: OutlineDiagnostic[] = [];
  const reported = new Set<number>();
  const label = (outline: SceneOutline, index: number) =>
    `outline #${index + 1} «${outline.title ?? ''}»`;
  const report = (
    index: number,
    code: string,
    field: string,
    message: string,
    extra: Pick<OutlineDiagnostic, 'flowIndex' | 'stage' | 'allowedValues'> = {},
  ): void => {
    if (reported.has(index)) return;
    reported.add(index);
    const outline = outlines[index]!;
    diagnostics.push({
      code,
      disposition: 'admin_correctable',
      outlineIndex: index,
      ...(outline.id ? { outlineId: outline.id } : {}),
      field,
      message,
      ...extra,
    });
  };
  for (const block of map.blocks) {
    const seen: Array<{ index: number; place: SlidePlacement; tryIt: boolean }> = [];
    outlines.forEach((outline, index) => {
      const stage = outline.teachingStage;
      if (!stage || stage.flowIndex !== block || flow[block]?.stage !== stage.key) return;
      const place = placementOf(outline, map);
      // The closing slide and the exercises block keep their own places.
      if (!place || isBlockTail(outline, outlines[index + 1], map)) return;
      const { anchor } = place;
      if (place.mixed) {
        const parts = [...new Set(place.cited.map((unit) => unit.partIndex))].sort((a, b) => a - b);
        report(
          index,
          SLIDE_OUT_OF_BOOK_ORDER,
          'sourceContentUnitIds',
          `${label(outline, index)} teaches units of two lesson parts that belong to different objective blocks (part ${parts.join(' and part ')}): plan each part's units on slides of their own block`,
        );
      } else if (anchor.flowIndex !== block) {
        report(
          index,
          SLIDE_OUT_OF_BOOK_ORDER,
          'teachingStage',
          `${label(outline, index)} teaches ${unitLabel(anchor)}, which belongs to the objective block at flow position ${anchor.flowIndex}: move it into that block`,
          {
            flowIndex: anchor.flowIndex,
            stage: flow[anchor.flowIndex]?.stage,
            allowedValues: [anchor.flowIndex],
          },
        );
      } else {
        const tryIt = outline.contentRole === 'check_understanding';
        const key = anchor.position;
        const rank = tryIt ? 0 : 1;
        for (const before of seen) {
          // Already reported as outside its block.
          if (before.place.mixed || before.place.anchor.flowIndex !== block) continue;
          // A solution before its try-it is the check's own finding (`solution_before_try_it`).
          if (before.place.checks.some((check) => place.checks.includes(check))) continue;
          const at = before.place.anchor.position;
          if (at < key || (at === key && (before.tryIt ? 0 : 1) <= rank)) continue;
          // A try-it that precedes a slide teaching an earlier unit of its own part is
          // the check asked too early; anything else is a slide that came too late.
          const early = before.tryIt
            ? before.place.checks.find(
                (check) => check.partIndex === anchor.partIndex && key < check.position,
              )
            : undefined;
          if (early !== undefined) {
            report(
              before.index,
              CHECK_BEFORE_ITS_PART,
              'order',
              `${label(outlines[before.index]!, before.index)} asks ${unitLabel(early)} before ${label(outline, index)}, which teaches ${unitLabel(anchor)}: the book prints that unit first. Move the check after every slide that teaches a unit printed before it in part ${early.partIndex}`,
            );
          } else {
            report(
              index,
              SLIDE_OUT_OF_BOOK_ORDER,
              'order',
              `${label(outline, index)} teaches ${unitLabel(anchor)} after ${label(outlines[before.index]!, before.index)}, which teaches ${unitLabel(before.place.anchor)}: the book prints it first. Move it before that slide`,
            );
          }
        }
      }
      seen.push({ index, place, tryIt: outline.contentRole === 'check_understanding' });
    });
  }
  return diagnostics;
}

export interface BookPartPlacementResult {
  outlines: SceneOutline[];
  /** Slides that changed objective block. */
  restaged: number;
  /** Slides that changed position. */
  moved: number;
  /** Teaching slides whose units belong to two objective blocks (placed by their first). */
  mixedOutlineIds: string[];
  /** Check quizzes re-grounded on what their block now teaches. */
  regroundedQuizIds: string[];
}

/**
 * Every teaching slide in book order, inside the objective block that owns its part.
 * Returns `null` when nothing changes, or when the placement would leave an objective
 * block that had slides without any (that plan stays as it is). Never mutates its input.
 */
export function placeOutlinesByBookPart(
  outlines: readonly SceneOutline[],
  map: BookPartMap,
  flow: readonly TeachingFlowEntry[],
): BookPartPlacementResult | null {
  const blocks = new Set(map.blocks);
  const inBlock = (outline: SceneOutline) => {
    const stage = outline.teachingStage;
    return (
      stage !== undefined &&
      stage.key === OBJECTIVE_EXPLANATION_STAGE &&
      blocks.has(stage.flowIndex) &&
      flow[stage.flowIndex]?.stage === stage.key
    );
  };
  const ownBlock = (outline: SceneOutline, flowIndex: number) =>
    inBlock(outline) && outline.teachingStage!.flowIndex === flowIndex;

  const placements: Placement[] = [];
  const mixedOutlineIds: string[] = [];
  // The blocks in which a teaching slide was already planned (before the current one).
  const taughtSoFar = new Set<number>();
  let previous: Placement | null = null;
  let previousBlock: number | null = null;
  outlines.forEach((outline, index) => {
    const own = outline.teachingStage?.flowIndex ?? -1;
    if (!inBlock(outline)) {
      placements.push({ flowIndex: own, group: 1, key: 0, rank: 1, tie: index, sub: 0 });
      previous = null;
      previousBlock = null;
      return;
    }
    // The chain of "follows the slide before it" never crosses an objective block.
    if (previousBlock !== own) previous = null;
    previousBlock = own;
    const lead: Placement = { flowIndex: own, group: 0, key: index, rank: 1, tie: index, sub: 0 };
    const tail: Placement = { flowIndex: own, group: 2, key: index, rank: 1, tie: index, sub: 0 };
    let placement: Placement;
    const teaching = teachingPlacement(outline, map);
    if (isBlockTail(outline, outlines[index + 1], map)) {
      placement = tail;
    } else if (teaching) {
      if (teaching.mixed) mixedOutlineIds.push(outline.id);
      taughtSoFar.add(own);
      placement = {
        flowIndex: teaching.flowIndex,
        group: 1,
        key: teaching.key,
        rank: outline.contentRole === 'check_understanding' ? 0 : 1,
        tie: index,
        sub: 0,
      };
    } else if (outline.slideType === 'transition' && !taughtSoFar.has(own)) {
      // The block's opening transition (no teaching slide planned before it in its
      // block) stays first in its block, whatever moves in or out.
      placement = lead;
    } else if (outline.slideType === 'transition') {
      // A transition inside a block opens what comes next there: the part of the next
      // teaching slide, or the block's tail (the closing slide, the exercises); with
      // neither after it, it stays behind the slide before it.
      let target: Placement | null = null;
      for (let next = index + 1; next < outlines.length; next += 1) {
        const candidate = outlines[next]!;
        if (!ownBlock(candidate, own)) break;
        if (isBlockTail(candidate, outlines[next + 1], map)) {
          target = tail;
          break;
        }
        const opened = teachingPlacement(candidate, map);
        if (opened) {
          target = {
            flowIndex: opened.flowIndex,
            group: 1,
            key: opened.key - 0.5,
            rank: 0,
            tie: index,
            sub: 0,
          };
          break;
        }
      }
      const before: Placement | null = previous;
      placement = target ?? (before ? { ...before, sub: before.sub + 1 } : lead);
    } else if (previous) {
      // Anything else (an attempt quiz, a slide citing nothing) follows the slide before it.
      const before: Placement = previous;
      placement = { ...before, sub: before.sub + 1 };
    } else {
      placement = lead;
    }
    placements.push(placement);
    previous = placement;
  });

  const order = outlines
    .map((outline, index) => ({ outline, index, placement: placements[index]! }))
    .sort(
      (a, b) =>
        a.placement.flowIndex - b.placement.flowIndex ||
        a.placement.group - b.placement.group ||
        a.placement.key - b.placement.key ||
        a.placement.rank - b.placement.rank ||
        a.placement.tie - b.placement.tie ||
        a.placement.sub - b.placement.sub ||
        a.index - b.index,
    );

  // An objective block that had slides must keep at least one, and one that taught
  // something must keep a teaching slide (a lone transition or closing slide is not a
  // block its check quiz could follow).
  const teachingIn = (
    entries: ReadonlyArray<{ outline: SceneOutline; flowIndex: number }>,
  ): Set<number> =>
    new Set(
      entries
        .filter(
          ({ outline }, index) =>
            inBlock(outline) &&
            teachingPlacement(outline, map) !== null &&
            !isBlockTail(outline, entries[index + 1]?.outline, map),
        )
        .map(({ flowIndex }) => flowIndex),
    );
  const before = new Set(outlines.filter(inBlock).map((o) => o.teachingStage!.flowIndex));
  const after = new Set(order.map((entry) => entry.placement.flowIndex));
  if ([...before].some((flowIndex) => !after.has(flowIndex))) return null;
  const taughtBefore = teachingIn(
    outlines.map((outline) => ({ outline, flowIndex: outline.teachingStage?.flowIndex ?? -1 })),
  );
  const taughtAfter = teachingIn(
    order.map((entry) => ({ outline: entry.outline, flowIndex: entry.placement.flowIndex })),
  );
  if ([...taughtBefore].some((flowIndex) => !taughtAfter.has(flowIndex))) return null;

  let restaged = 0;
  let moved = 0;
  let placed = order.map((entry, position): SceneOutline => {
    if (entry.index !== position) moved += 1;
    const target = entry.placement.flowIndex;
    if (!inBlock(entry.outline) || entry.outline.teachingStage!.flowIndex === target) {
      return { ...entry.outline, order: position + 1 };
    }
    restaged += 1;
    const statement = map.statements.get(target);
    return {
      ...entry.outline,
      teachingStage: { key: flow[target]!.stage, flowIndex: target },
      // The slide now teaches under the block's objective.
      ...(statement !== undefined && entry.outline.teachingObjective !== undefined
        ? { teachingObjective: statement }
        : {}),
      order: position + 1,
    };
  });
  if (restaged === 0 && moved === 0) return null;
  const regrounded = regroundCheckQuizzes(outlines, placed, map, flow, inBlock);
  placed = regrounded.outlines;
  return { outlines: placed, restaged, moved, mixedOutlineIds, regroundedQuizIds: regrounded.ids };
}

/**
 * An objective's check quiz is written from its outline alone (title, description, key
 * points; the quiz prompt reads no source unit): after a placement, whenever its block's
 * taught units changed, the outline is grounded again on what that block now teaches —
 * its units in book order, a description naming the block's teaching slides, and key
 * points taken from every one of them in turn. Otherwise a quiz would test a part that
 * moved away, before it is taught. The title (the objective's label) stays.
 */
function regroundCheckQuizzes(
  planned: readonly SceneOutline[],
  placed: readonly SceneOutline[],
  map: BookPartMap,
  flow: readonly TeachingFlowEntry[],
  inBlock: (outline: SceneOutline) => boolean,
): { outlines: SceneOutline[]; ids: string[] } {
  // The block's teaching slides: not its transitions, closing slide or exercises.
  const taughtBy = (outlines: readonly SceneOutline[], flowIndex: number) =>
    outlines.filter(
      (outline, index) =>
        inBlock(outline) &&
        outline.teachingStage!.flowIndex === flowIndex &&
        teachingPlacement(outline, map) !== null &&
        !isBlockTail(outline, outlines[index + 1], map),
    );
  const unitsOf = (outlines: readonly SceneOutline[]) =>
    [
      ...new Set(
        outlines.flatMap((outline) =>
          (outline.sourceContentUnitIds ?? []).map(String).filter((id) => map.units.has(id)),
        ),
      ),
    ].sort((a, b) => map.units.get(a)!.position - map.units.get(b)!.position);
  // Every slide's first key point, then every slide's second, …: each slide is tested.
  const keyPointsOf = (slides: readonly SceneOutline[]) => {
    const picked: string[] = [];
    const rows = slides.map((slide) => slide.keyPoints ?? []);
    for (let depth = 0; picked.length < MAX_QUIZ_KEY_POINTS; depth += 1) {
      const layer = rows.map((row) => row[depth]).filter((point): point is string => !!point);
      if (layer.length === 0) break;
      for (const point of layer) {
        if (picked.length < MAX_QUIZ_KEY_POINTS && !picked.includes(point)) picked.push(point);
      }
    }
    return picked.length > 0 ? picked : slides.map((slide) => slide.title);
  };

  const ids: string[] = [];
  let outlines = [...placed];
  for (const block of map.blocks) {
    const quizAt = flow.findIndex(
      (entry, index) => index > block && entry.stage === OBJECTIVE_CHECK_STAGE,
    );
    const nextBlock = map.blocks.find((other) => other > block) ?? Infinity;
    if (quizAt < 0 || quizAt > nextBlock) continue;
    const was = unitsOf(taughtBy(planned, block));
    const slides = taughtBy(outlines, block);
    const now = unitsOf(slides);
    if (now.length === 0 || (was.length === now.length && was.every((id, i) => id === now[i]))) {
      continue;
    }
    const keyPoints = keyPointsOf(slides);
    const description = slides.map((slide) => slide.title).join(' • ');
    outlines = outlines.map((outline) => {
      if (outline.type !== 'quiz' || outline.teachingStage?.flowIndex !== quizAt) return outline;
      ids.push(outline.id);
      return { ...outline, sourceContentUnitIds: now, description, keyPoints };
    });
  }
  return { outlines, ids };
}

export interface GuardedPlacement {
  outlines: SceneOutline[];
  /** The kept placement, or `null` when nothing was placed. */
  placement: BookPartPlacementResult | null;
  /** The codes that made the placement roll back (one more of a code counts too). */
  rolledBackFor: string[];
}

/**
 * The placement, kept only when the re-diagnosis finds no blocking issue the planned
 * order did not have — counted per code, so one more of an issue already open rolls it
 * back too. `diagnose` returns the open blocking codes of a candidate.
 */
export function placeWithGuard(
  planned: SceneOutline[],
  map: BookPartMap,
  flow: readonly TeachingFlowEntry[],
  diagnose: (candidate: SceneOutline[]) => readonly string[],
): GuardedPlacement {
  const placement = placeOutlinesByBookPart(planned, map, flow);
  if (!placement) return { outlines: planned, placement: null, rolledBackFor: [] };
  const count = (codes: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
    return counts;
  };
  const was = count(diagnose(planned));
  const now = count(diagnose(placement.outlines));
  const added = [...now].filter(([code, n]) => n > (was.get(code) ?? 0)).map(([code]) => code);
  if (added.length > 0) return { outlines: planned, placement: null, rolledBackFor: added };
  return { outlines: placement.outlines, placement, rolledBackFor: [] };
}

/** A placed candidate and what its re-diagnosis leaves open. */
export interface PlacedCandidate {
  outlines: SceneOutline[];
  blocking: OutlineDiagnostic[];
  /** The kept placement, or `null` when the plan stays as it is. */
  placement: BookPartPlacementResult | null;
  /** The codes that made the placement roll back (one more of a code counts too). */
  rolledBackFor: string[];
}

/** g5.v12: which objective block owns a part, and which flow positions are blocks. */
export interface BookPartBlocks {
  ownerBlockOf: (unitId: string) => number | undefined;
  isObjectiveBlock: (flowIndex: number) => boolean;
}

/**
 * The book-part blocks of a g5.v12 version, from its retained attempt (the request's
 * book map and objectives). `null` on every other version, or when the attempt cannot
 * carry them; then a part moves and a slide is inserted as before.
 */
export function bookPartBlocksFor(
  teachingModel: { key?: string | null; version?: string | null } | null | undefined,
  snapshot:
    | Pick<GenerationInputSnapshot, 'bookStructure' | 'learningObjectives' | 'teachingFlow'>
    | null
    | undefined,
): BookPartBlocks | null {
  const map = bookPartMapFor(
    teachingModel,
    snapshot?.bookStructure,
    snapshot?.learningObjectives,
    snapshot?.teachingFlow ?? [],
  );
  if (!map) return null;
  const blocks = new Set(map.blocks);
  return {
    ownerBlockOf: (unitId) => map.units.get(unitId)?.flowIndex,
    isObjectiveBlock: (flowIndex) => blocks.has(flowIndex),
  };
}

/**
 * Whether a person moved or re-staged a slide of a paused plan (read from its edit log).
 * The resumed run and the paused plan's review then never place its slides again: their
 * correction stands (overnight decision N-7).
 */
export function personPlacedOutlines(
  editLog: readonly Pick<GenerationCheckpointLogEntry, 'event' | 'operations'>[],
): boolean {
  return editLog.some(
    (entry) =>
      entry.event === 'edited' &&
      (entry.operations ?? []).some((operation) => {
        const { op, field } = (operation ?? {}) as { op?: unknown; field?: unknown };
        return op === 'move' || (op === 'set' && field === 'teachingStage');
      }),
  );
}

/**
 * {@link placeWithGuard} on a candidate, with the re-diagnosis the caller already uses:
 * the placed plan comes back as that diagnosis normalised it, with its open issues, so
 * what the placement could not put right is still open for the next step (fail closed).
 */
export function placeCandidate(
  outlines: SceneOutline[],
  map: BookPartMap,
  flow: readonly TeachingFlowEntry[],
  diagnose: (candidate: SceneOutline[]) => {
    outlines: SceneOutline[];
    blocking: OutlineDiagnostic[];
  },
): PlacedCandidate {
  const guarded = placeWithGuard(outlines, map, flow, (candidate) =>
    diagnose(candidate).blocking.map((issue) => issue.code),
  );
  if (!guarded.placement) {
    return {
      outlines,
      blocking: diagnose(outlines).blocking,
      placement: null,
      rolledBackFor: guarded.rolledBackFor,
    };
  }
  const diagnosed = diagnose(guarded.outlines);
  return {
    outlines: diagnosed.outlines,
    blocking: diagnosed.blocking,
    placement: guarded.placement,
    rolledBackFor: [],
  };
}

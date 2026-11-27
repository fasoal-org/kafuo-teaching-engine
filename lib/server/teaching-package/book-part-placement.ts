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
 */
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  LearningObjectiveRef,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

/** The per-objective explanation position of every g5 flow (one per objective, in order). */
export const OBJECTIVE_EXPLANATION_STAGE = 'outcome_visual_explanations';
/** The per-objective check quiz position, right after the objective's explanation block. */
export const OBJECTIVE_CHECK_STAGE = 'outcome_check_understanding';

/**
 * The book elements a part teaches. Recall, exercises, objective sources, ignored units
 * and untyped units (no template element; the runner may retype a practice unit as an
 * exercise) are placed by their own rules, never by part.
 */
const TEACHING_ELEMENTS: ReadonlySet<string> = new Set([
  'key_concept',
  'worked_example',
  'try_it',
  'supporting',
]);

const STRUCTURAL_SLIDE_TYPES: ReadonlySet<string> = new Set(['cover', 'contents', 'transition']);

/** How many key points a re-grounded check quiz keeps (one or more from each slide). */
const MAX_QUIZ_KEY_POINTS = 8;

interface PlacedUnit {
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
 * objectives (the backend never sends one).
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
    if (unit.element === 'exercise') exerciseUnitIds.add(id);
    if (unit.partIndex === undefined || !TEACHING_ELEMENTS.has(String(unit.element))) continue;
    const owner = ownerOf.get(id);
    if (owner === undefined) continue;
    const flowIndex = blocks[owner]!;
    units.set(id, { position, partIndex: unit.partIndex, flowIndex, element: unit.element });
    let part = parts.find((entry) => entry.partIndex === unit.partIndex);
    if (!part) {
      part = {
        partIndex: unit.partIndex,
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
 * The planner text: the parts in book order, each with its units and the objective block
 * its slides must carry. Appended to the requirement of a g5.v12 request only.
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

/**
 * A teaching slide's place: by the check it sets when it cites one, else its earliest
 * unit. A try-it slide takes its first check, any other slide citing checks (a solution)
 * its last, so a solution never comes before the try-it of a check it solves — even when
 * it also cites the example before it.
 */
function teachingPlacement(
  outline: SceneOutline,
  map: BookPartMap,
): { flowIndex: number; key: number; mixed: boolean } | null {
  if (outline.type !== 'slide' || STRUCTURAL_SLIDE_TYPES.has(String(outline.slideType ?? ''))) {
    return null;
  }
  const cited = (outline.sourceContentUnitIds ?? [])
    .map((id) => map.units.get(String(id)))
    .filter((unit): unit is PlacedUnit => unit !== undefined);
  if (cited.length === 0) return null;
  const checks = cited.filter((unit) => unit.element === 'try_it');
  const pool = checks.length > 0 ? checks : cited;
  const last = checks.length > 0 && outline.contentRole !== 'check_understanding';
  const anchor = pool.reduce((chosen, unit) =>
    (last ? unit.position > chosen.position : unit.position < chosen.position) ? unit : chosen,
  );
  return {
    flowIndex: anchor.flowIndex,
    key: anchor.position,
    mixed: new Set(cited.map((unit) => unit.flowIndex)).size > 1,
  };
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

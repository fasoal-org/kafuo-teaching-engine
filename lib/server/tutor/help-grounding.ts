/**
 * Scene-grounded Help unit selection (Kafuo R1 FRD HLP-02/04; plan §8.3,
 * §8.7 step 4, P7).
 *
 * The candidates are ONLY the resolved Content Units of the current Scene's
 * `sourceContentUnitIds`, in cited order. Nothing here can add a unit: the
 * selector chooses a subset, orders it, and at most head-cuts one unit.
 *
 *   - total ≤ cap                → every candidate, cited order, untouched
 *   - total > cap                → score each unit by keyword overlap with the
 *                                  question (weight 2), the Scene title and the
 *                                  visible step text (weight 1); pick greedily
 *                                  by score (ties → cited order) while the
 *                                  running total stays under the cap; re-sort
 *                                  the picks to cited order
 *   - nothing fits (one giant)   → the best-scored unit head-cut at the last
 *                                  paragraph boundary, `truncated: true` (the
 *                                  assembler renders the "excerpt" note)
 *
 * `assessSceneScope` is the deterministic HLP-04 rule: a real content
 * question (≥ SCOPE_MIN_KEYWORDS keywords) that shares NO keyword with the
 * Scene (title + visible text + every candidate unit) is outside the Scene;
 * the turn then runs with `grounding_mode='insufficient'` and the Help scope
 * note tells the tutor to say so and point to Free Chat. Short follow-ups
 * ("explain again", "a hint") always stay anchored.
 *
 * Pure functions: no I/O, no model, nothing logged.
 */
import { extractKeywords } from '@/lib/server/tutor/arabic-text';
import { detectFollowUpCue, type FollowUpCue } from '@/lib/server/tutor/context-assessment';
import { headCutUnit } from '@/lib/server/tutor/prompt-assembly';
import { UNIT_CHAR_CAP } from '@/lib/server/tutor/token-budget';

export interface HelpUnitCandidate {
  unitId: string;
  title: string | null;
  text: string;
}

export interface SelectHelpUnitsInput {
  /** The Scene's resolved units in CITED order (`sourceContentUnitIds` order). */
  candidates: readonly HelpUnitCandidate[];
  question: string;
  sceneTitle?: string | null;
  /** Visible Scene / step text (never hidden future steps). */
  visibleStepText?: string | null;
  /** Defaults to `UNIT_CHAR_CAP` (10,000). */
  cap?: number;
}

export interface SelectedHelpUnit extends HelpUnitCandidate {
  /** Position in the cited list (stable ordering key). */
  citedIndex: number;
  chars: number;
  /** Keyword-overlap score used for prioritisation (0 when nothing matched). */
  score: number;
  /** The unit was head-cut at a paragraph boundary to fit the cap. */
  truncated: boolean;
}

export interface HelpUnitSelection {
  /** In cited order; never a unit outside `candidates`. */
  units: SelectedHelpUnit[];
  totalChars: number;
  /** At least one unit was head-cut. */
  truncated: boolean;
  /** Candidates that did not make it (cited order). */
  droppedUnitIds: string[];
  /** True when the candidates exceeded the cap and a subset was chosen. */
  capped: boolean;
}

/** Content-keyword count a question needs before it can be judged "outside the Scene". */
export const SCOPE_MIN_KEYWORDS = 3;

function chars(candidate: HelpUnitCandidate): number {
  return candidate.text.length;
}

/** Overlap score: question keyword hits count double; Scene title / step hits once. */
function scoreUnit(
  unit: HelpUnitCandidate,
  questionKeywords: readonly string[],
  sceneKeywords: readonly string[],
): number {
  if (questionKeywords.length === 0 && sceneKeywords.length === 0) return 0;
  const unitKeywords = new Set(extractKeywords(`${unit.title ?? ''} ${unit.text}`));
  let score = 0;
  for (const keyword of questionKeywords) if (unitKeywords.has(keyword)) score += 2;
  for (const keyword of sceneKeywords) if (unitKeywords.has(keyword)) score += 1;
  return score;
}

export function selectHelpUnits(input: SelectHelpUnitsInput): HelpUnitSelection {
  const cap = input.cap ?? UNIT_CHAR_CAP;
  const indexed = input.candidates.map((candidate, citedIndex) => ({ candidate, citedIndex }));
  const total = indexed.reduce((sum, entry) => sum + chars(entry.candidate), 0);

  const questionKeywords = extractKeywords(input.question);
  const sceneKeywords = extractKeywords(
    `${input.sceneTitle ?? ''} ${input.visibleStepText ?? ''}`,
  ).filter((keyword) => !questionKeywords.includes(keyword));
  const scored = indexed.map((entry) => ({
    ...entry,
    score: scoreUnit(entry.candidate, questionKeywords, sceneKeywords),
  }));

  const finish = (
    picks: Array<{
      candidate: HelpUnitCandidate;
      citedIndex: number;
      score: number;
      text?: string;
      truncated?: boolean;
    }>,
    capped: boolean,
  ): HelpUnitSelection => {
    const ordered = [...picks].sort((a, b) => a.citedIndex - b.citedIndex);
    const units: SelectedHelpUnit[] = ordered.map((pick) => {
      const text = pick.text ?? pick.candidate.text;
      return {
        unitId: pick.candidate.unitId,
        title: pick.candidate.title,
        text,
        citedIndex: pick.citedIndex,
        chars: text.length,
        score: pick.score,
        truncated: pick.truncated === true,
      };
    });
    const kept = new Set(units.map((unit) => unit.unitId));
    return {
      units,
      totalChars: units.reduce((sum, unit) => sum + unit.chars, 0),
      truncated: units.some((unit) => unit.truncated),
      droppedUnitIds: indexed
        .filter((entry) => !kept.has(entry.candidate.unitId))
        .map((entry) => entry.candidate.unitId),
      capped,
    };
  };

  if (indexed.length === 0) return finish([], false);
  if (total <= cap) return finish(scored, false);

  // Greedy by score (ties → cited order) under the cap.
  const byPriority = [...scored].sort((a, b) => b.score - a.score || a.citedIndex - b.citedIndex);
  const picks: typeof byPriority = [];
  let running = 0;
  for (const entry of byPriority) {
    const size = chars(entry.candidate);
    if (running + size > cap) continue;
    picks.push(entry);
    running += size;
  }
  if (picks.length > 0) return finish(picks, true);

  // Every candidate alone exceeds the cap: head-cut the best one (partial excerpt).
  const best = byPriority[0]!;
  const cut = headCutUnit({ title: best.candidate.title, text: best.candidate.text }, cap);
  return finish([{ ...best, text: cut.text, truncated: true }], true);
}

// ---------------------------------------------------------------------------
// Scene scope (HLP-04)
// ---------------------------------------------------------------------------

export type SceneScopeDecision = 'in_scope' | 'outside_scene';

export interface SceneScopeAssessment {
  decision: SceneScopeDecision;
  /** Share of the question's content keywords found in the Scene (0..1). */
  overlap: number;
  keywordCount: number;
  /** A greeting / continuation / answer-check cue keeps the turn anchored. */
  cue: FollowUpCue | null;
}

export interface AssessSceneScopeInput {
  question: string;
  sceneTitle?: string | null;
  visibleStepText?: string | null;
  units: readonly HelpUnitCandidate[];
}

/**
 * Outside the Scene = a real content question (no follow-up cue) with ZERO
 * keyword overlap with the Scene title, its visible text and every cited
 * unit. Anything shorter, cued ("explain again", "a hint", "is my answer
 * right") or with any overlap stays in scope (the tutor answers from the
 * Scene, and says so when the Scene does not cover it — the rules already
 * ask for that).
 */
export function assessSceneScope(input: AssessSceneScopeInput): SceneScopeAssessment {
  const questionKeywords = extractKeywords(input.question);
  const keywordCount = questionKeywords.length;
  const cue = detectFollowUpCue(input.question);
  if (keywordCount === 0) return { decision: 'in_scope', overlap: 0, keywordCount, cue };
  const reference = new Set(
    extractKeywords(
      [
        input.sceneTitle ?? '',
        input.visibleStepText ?? '',
        ...input.units.map((unit) => `${unit.title ?? ''} ${unit.text}`),
      ].join(' '),
    ),
  );
  let hits = 0;
  for (const keyword of questionKeywords) if (reference.has(keyword)) hits += 1;
  const overlap = hits / keywordCount;
  const decision: SceneScopeDecision =
    cue === null && keywordCount >= SCOPE_MIN_KEYWORDS && hits === 0 ? 'outside_scene' : 'in_scope';
  return { decision, overlap, keywordCount, cue };
}

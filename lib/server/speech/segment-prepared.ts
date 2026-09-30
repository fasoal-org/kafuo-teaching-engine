/**
 * Segmentation of prepared text (plan §13.2, FR-028, FR-029). One speech
 * Action → one audio asset; oversized prepared text is split into provider
 * segments here, never into new Actions. Deterministic:
 *
 * 1. cut candidates, by preference: sentence ends (. ؟ ! ؛ newline), clause
 *    marks (، , :), word boundaries;
 * 2. a cut is FORBIDDEN inside any atomic span (every expression);
 * 3. greedy: the furthest allowed cut of the best available class that keeps
 *    the segment within both budgets;
 * 4. an atomic span that alone exceeds the budget blocks this Action
 *    (`SATTS_E_SEGMENT_UNSPLITTABLE`).
 */
import type { RenderedSpan } from '@/lib/speech/scientific/result';

export interface SegmentBudget {
  maxChars: number;
  /** Estimated-token budget per segment (κ applied), if the provider has one. */
  maxTokens?: number;
  kappa: number;
  /** Tokens of the instructions sent with every segment (they count, M1). */
  instructionsTokens: number;
  /** Documented hard cap and margin; asserted, never binding at the budget. */
  hardTokenCap?: number;
}

export interface PreparedSegment {
  text: string;
  start: number;
  end: number;
}

export type SegmentResult =
  | { ok: true; segments: PreparedSegment[] }
  | { ok: false; code: 'SATTS_E_SEGMENT_UNSPLITTABLE'; at: number };

const SENTENCE_END = new Set(['.', '؟', '?', '!', '؛', '\n']);
const CLAUSE_MARK = new Set(['،', ',', ':']);

function cutClass(text: string, index: number): 1 | 2 | 3 | null {
  // A cut at `index` ends the segment just before text[index].
  const before = text[index - 1];
  if (before === undefined) return null;
  if (SENTENCE_END.has(before)) return 1;
  if (CLAUSE_MARK.has(before)) return 2;
  if (/\s/.test(before) || /\s/.test(text[index] ?? '')) return 3;
  return null;
}

export function segmentPrepared(
  preparedText: string,
  spans: readonly Pick<RenderedSpan, 'prepared' | 'atomic'>[],
  budget: SegmentBudget,
  countTokens: (text: string) => number,
): SegmentResult {
  const text = preparedText;
  const forbidden = (index: number) =>
    spans.some((span) => span.atomic && index > span.prepared.start && index < span.prepared.end);
  const fits = (start: number, end: number) => {
    const piece = text.slice(start, end).trim();
    if (piece.length > budget.maxChars) return false;
    if (budget.maxTokens === undefined && budget.hardTokenCap === undefined) return true;
    const tokens = budget.kappa * (countTokens(piece) + budget.instructionsTokens);
    if (budget.maxTokens !== undefined && tokens > budget.maxTokens) return false;
    if (budget.hardTokenCap !== undefined && tokens > budget.hardTokenCap) return false;
    return true;
  };

  const segments: PreparedSegment[] = [];
  let start = 0;
  while (start < text.length) {
    if (fits(start, text.length)) {
      segments.push({ text: text.slice(start).trim(), start, end: text.length });
      break;
    }
    // Candidate cuts within the character budget, grouped by class.
    const limit = Math.min(text.length, start + budget.maxChars + 1);
    let chosen: number | null = null;
    for (const wanted of [1, 2, 3] as const) {
      for (let index = limit; index > start; index -= 1) {
        if (cutClass(text, index) !== wanted || forbidden(index)) continue;
        if (!text.slice(start, index).trim()) continue;
        if (fits(start, index)) {
          chosen = index;
          break;
        }
      }
      if (chosen !== null) break;
    }
    if (chosen === null) return { ok: false, code: 'SATTS_E_SEGMENT_UNSPLITTABLE', at: start };
    segments.push({ text: text.slice(start, chosen).trim(), start, end: chosen });
    start = chosen;
    while (start < text.length && /\s/.test(text[start]!)) start += 1;
  }
  return { ok: true, segments: segments.filter((segment) => segment.text.length > 0) };
}

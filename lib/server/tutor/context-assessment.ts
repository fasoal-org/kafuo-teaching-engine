/**
 * Rule-based Tutor Context Assessment (FRD CTX-01..05, EFF-01; plan §8.2,
 * Revision 1 rule order).
 *
 * A PURE function over normalised text: it never answers the student, never
 * selects a model, never calls a judge, never retrieves. It decides, per Free
 * Chat turn, whether the conversation's current grounding is reused, fresh
 * curriculum evidence is retrieved, or the turn is answered as subject-level
 * conversation without retrieval.
 *
 * Rules, in order (the first that fires wins; `rule` names it):
 *   1. social/meta            → none
 *   2. explicit curriculum     → reuse if overlap ≥ 0.15 else retrieve
 *   3. continuation cue        → reuse (grounding used within the last 6 turns)
 *   4. answer-check / hint cue → reuse if grounding exists else none
 *   5. topic continuity        → overlap ≥ 0.2 → reuse; zero overlap with ≥ 2
 *                                content keywords → retrieve
 *   6. lesson discovery        → retrieve (no grounding; quoted phrase, ≥ 3
 *                                consecutive content keywords, lesson-ish noun)
 *   7. default                 → none
 *
 * A grounding not used for more than `GROUNDING_STALE_TURNS` (12) turns is
 * treated as absent before any rule runs. Lesson association (CTX-04) is a
 * separate decision over the retrieval response: only when
 * `lessonMatch.confidence ≥ TUTOR_LESSON_MATCH_THRESHOLD` (0.45) AND every
 * returned unit belongs to that lesson.
 */
import {
  detectScript,
  extractKeywords,
  hasQuotedPhrase,
  keywordOverlap,
  longestContentRun,
  normalizeText,
} from '@/lib/server/tutor/arabic-text';
import type { GroundingSearchResponse } from '@/lib/server/tutor/kafuo-integration-client';

export type ContextDecision = 'reuse' | 'retrieve' | 'none';

export type AssessmentRule =
  | 'social_meta'
  | 'explicit_curriculum_reuse'
  | 'explicit_curriculum_retrieve'
  | 'continuation'
  | 'answer_check_reuse'
  | 'answer_check_none'
  | 'topic_continuity_reuse'
  | 'topic_shift_retrieve'
  | 'lesson_discovery'
  | 'default_none';

export interface AssessmentGrounding {
  /** Keywords of the current grounding snapshot (built when it was set). */
  keywords: readonly string[];
  /** Whole turns since the grounding was last used in a prompt (0 = last turn). */
  turnsSinceUse: number;
}

export interface AssessContextInput {
  message: string;
  grounding: AssessmentGrounding | null;
}

export interface ContextAssessment {
  decision: ContextDecision;
  rule: AssessmentRule;
  /** The retrieval query (content keywords joined) on `retrieve`. */
  query?: string;
  /** Content keywords of the message (for the snapshot and the title fallback). */
  keywords: string[];
  /** Overlap with the (non-stale) grounding, 0 when absent. */
  overlap: number;
  /** True when a grounding existed but was ignored as stale. */
  groundingStale: boolean;
}

export const GROUNDING_STALE_TURNS = 12;
export const CONTINUATION_RECENT_TURNS = 6;
export const EXPLICIT_REUSE_OVERLAP = 0.15;
export const CONTINUITY_REUSE_OVERLAP = 0.2;
export const DEFAULT_LESSON_MATCH_THRESHOLD = 0.45;

/** `TUTOR_LESSON_MATCH_THRESHOLD`, default 0.45, clamped to (0, 1]. */
export function lessonMatchThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.TUTOR_LESSON_MATCH_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_LESSON_MATCH_THRESHOLD;
  return raw;
}

// ---------------------------------------------------------------------------
// Lexicons (matched against the NORMALISED message)
// ---------------------------------------------------------------------------

const SOCIAL_META = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|bye|good ?bye|good (morning|evening|night))\b[!. ]*$/,
  /^(who are you|what are you|what can you do|are you (a )?(bot|robot|human|ai))\b/,
  /^(مرحبا|اهلا|السلام عليكم|صباح الخير|مساء الخير|شكرا|شكرا لك|تمام|طيب|اوك|مع السلامه|باي)[!. ]*$/,
  /^(من انت|انت مين|مين انت|انت ايه|ايه اللي تقدر تعمله|هل انت روبوت|هل انت انسان)(?!\p{L})/u,
];

const EXPLICIT_CURRICULUM = [
  /\b(in|from|per|according to) the (textbook|book|lesson|curriculum|syllabus|chapter|unit)\b/,
  /\b(textbook|curriculum|syllabus|lesson|book) (say|says|said|definition|wording|state|states)\b/,
  /\b(define|definition of|what is the definition|official (term|definition)|exact wording)\b/,
  /\b(as (written|stated) in)\b/,
  /(في|من|حسب|طبقا ل|وفق|وفقا ل|زي ما في|زي ما جه في) ?(الدرس|الكتاب|المنهج|المقرر|الفصل|الوحده)/,
  /(تعريف|عرف|ما هو تعريف|ايه تعريف|التعريف الرسمي|بالنص|نص الدرس|صيغه الدرس|كلام الكتاب)/,
];

const CONTINUATION = [
  /\b(why|how come|again|simpler|simplify|easier|example|another example|more|elaborate|explain (it|that|this)|what do you mean|i (don'?t|do not) (get|understand) (it|that|this)|continue|go on|next|and then)\b/,
  /^(what|so|then|and|but|why|how)\b.{0,25}$/,
  /(ليه|لماذا|بسط|ابسط|اسهل|مثال|مثال تاني|مثال اخر|كمان|وضح|اشرح تاني|اشرحها|عيد|تاني|ما فهمت|مش فاهم|مفهمتش|كمل|وبعدين|يعني ايه|قصدك ايه|اكثر|بالتفصيل)/,
];

const ANSWER_CHECK = [
  /\b(is (my|this) answer (right|correct|ok)|check my (answer|work|solution)|did i (get|do) it right|am i right|correct me|hint|a hint|give me a hint|just a hint|don'?t (tell|give) me the (answer|solution))\b/,
  /(هل اجابتي صحيحه|اجابتي صح|صح ولا غلط|صح كده|هل الحل صح|راجع حلي|راجع اجابتي|صحح لي|تلميح|لمحه|من غير ما تقول الحل|من غير الحل|بس تلميح)/,
];

const LESSON_NOUNS = [
  /\b(lesson|chapter|unit|topic|law|theorem|rule|principle|section|paragraph)\b/,
  /(درس|الدرس|فصل|الفصل|وحده|الوحده|موضوع|قانون|نظريه|قاعده|مبدا|باب|فقره)/,
];

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export type FollowUpCue = 'social_meta' | 'continuation' | 'answer_check';

/**
 * The lexical cue a message carries, if any (Help scope rule, HLP-03/04): a
 * greeting, a continuation ("explain again", "simpler", "an example") or an
 * answer-check / hint request stays anchored to the current Scene whatever
 * its keyword overlap. Shared with the Free Chat rules above.
 */
export function detectFollowUpCue(message: string): FollowUpCue | null {
  const normalized = normalizeText(message);
  if (matchesAny(SOCIAL_META, normalized)) return 'social_meta';
  if (matchesAny(CONTINUATION, normalized)) return 'continuation';
  if (matchesAny(ANSWER_CHECK, normalized)) return 'answer_check';
  return null;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export function assessContext(input: AssessContextInput): ContextAssessment {
  const normalized = normalizeText(input.message);
  const keywords = extractKeywords(input.message);
  const stale = input.grounding !== null && input.grounding.turnsSinceUse > GROUNDING_STALE_TURNS;
  const grounding = input.grounding !== null && !stale ? input.grounding : null;
  const overlap = grounding ? keywordOverlap(keywords, grounding.keywords) : 0;
  const query = keywords.join(' ');
  const base = { keywords, overlap, groundingStale: stale };

  // 1. social / meta
  if (matchesAny(SOCIAL_META, normalized)) {
    return { decision: 'none', rule: 'social_meta', ...base };
  }

  // 2. explicit curriculum signal
  if (matchesAny(EXPLICIT_CURRICULUM, normalized)) {
    if (grounding && overlap >= EXPLICIT_REUSE_OVERLAP) {
      return { decision: 'reuse', rule: 'explicit_curriculum_reuse', ...base };
    }
    return { decision: 'retrieve', rule: 'explicit_curriculum_retrieve', query, ...base };
  }

  // 3. continuation cue with a recently used grounding
  const shortMessage = keywords.length <= 3;
  if (
    grounding &&
    grounding.turnsSinceUse <= CONTINUATION_RECENT_TURNS &&
    (matchesAny(CONTINUATION, normalized) || (shortMessage && overlap > 0))
  ) {
    return { decision: 'reuse', rule: 'continuation', ...base };
  }

  // 4. answer-check / hint cue
  if (matchesAny(ANSWER_CHECK, normalized)) {
    return grounding
      ? { decision: 'reuse', rule: 'answer_check_reuse', ...base }
      : { decision: 'none', rule: 'answer_check_none', ...base };
  }

  // 5. topic continuity against the current grounding
  if (grounding) {
    if (overlap >= CONTINUITY_REUSE_OVERLAP) {
      return { decision: 'reuse', rule: 'topic_continuity_reuse', ...base };
    }
    if (overlap === 0 && keywords.length >= 2) {
      return { decision: 'retrieve', rule: 'topic_shift_retrieve', query, ...base };
    }
  }

  // 6. lesson discovery without grounding
  if (
    !grounding &&
    (hasQuotedPhrase(input.message) ||
      longestContentRun(input.message) >= 3 ||
      (matchesAny(LESSON_NOUNS, normalized) && keywords.length >= 2))
  ) {
    return { decision: 'retrieve', rule: 'lesson_discovery', query, ...base };
  }

  // 7. default: subject-level conversation
  return { decision: 'none', rule: 'default_none', ...base };
}

// ---------------------------------------------------------------------------
// Lesson association (CTX-04)
// ---------------------------------------------------------------------------

export interface LessonAssociationDecision {
  lessonId: string;
  lessonTitle: string;
  confidence: number;
}

/**
 * Associate the conversation with a lesson only when retrieval is confident
 * AND every returned unit belongs to that lesson; otherwise stay
 * subject-scoped (never claim a lesson match).
 */
export function decideLessonAssociation(
  response: Pick<GroundingSearchResponse, 'units' | 'lessonMatch'>,
  threshold: number = lessonMatchThreshold(),
): LessonAssociationDecision | null {
  const match = response.lessonMatch;
  if (!match || match.confidence < threshold) return null;
  if (response.units.length === 0) return null;
  if (!response.units.every((unit) => unit.lessonId === match.lessonId)) return null;
  return { lessonId: match.lessonId, lessonTitle: match.lessonTitle, confidence: match.confidence };
}

/** Keywords describing a grounding snapshot: unit titles + text heads. */
export function groundingKeywords(
  units: ReadonlyArray<{ unitTitle?: string | null; title?: string | null; text: string }>,
  maxPerUnit = 40,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const unit of units) {
    const title = unit.unitTitle ?? unit.title ?? '';
    const words = extractKeywords(`${title} ${unit.text.slice(0, 2000)}`).slice(0, maxPerUnit);
    for (const word of words) {
      if (seen.has(word)) continue;
      seen.add(word);
      out.push(word);
    }
  }
  return out;
}

export { detectScript };

/**
 * Quran and hadith text in a Teaching Package: never changed, never explained
 * (owner rule, plan `docs/frds/quran-text-handling-rules-plan-2026-11-04.md`,
 * rules Q-4 to Q-15, TE half, and the review fix plan S-0 to S-6).
 *
 * One pure module for every TE step that touches a protected quote:
 *
 * - **Detection (S-0).** {@link findSacredSpans} is the ONE rule, shared with
 *   the backend through `tests/fixtures/sacred-text/contract_cases.json`:
 *   verses are ﴿…﴾ spans paired sequentially (any unpaired bracket voids every
 *   verse of the text); a hadith is a «…», "…" or “…” quote right after an
 *   explicit attribution to the Prophet ﷺ. A hadith's canonical text is the
 *   trimmed inner quote; a verse's is the trimmed span with its brackets.
 * - **Input (Q-3 contract).** Each normalized Content Unit may carry
 *   `sacred_quotes` (the backend export; `sacredQuotes` is read too). An older
 *   backend sends none: the unit text is detected here with the same rule.
 * - **Validation (Q-5, Q-12, Q-13, Q-7, Q-10, Q-11, S-2, S-3).**
 *   {@link validateSacredText} checks the generated Scenes.
 * - **Repairs before media and TTS (Q-7, Q-11, S-4).** {@link stripSacredNarration}
 *   replaces each sentence that reads a quote with the owner's line, by the
 *   same predicate the check uses, and {@link stripSacredTextFromMediaRequests}
 *   keeps quote text out of image prompts.
 * - **Integrity (Q-14, S-5).** {@link usedSacredQuotePins} lists the quotes the
 *   package may show (sha256 of the canonical text + source block id);
 *   {@link findPinnedSacredTextEdits} refuses an editor write whose quote spans
 *   are not pinned.
 *
 * Findings and log lines never carry lesson text: codes, Scene ids and counts.
 */
import { createHash } from 'node:crypto';

import type { SacredQuotePin } from '@/lib/types/teaching-package';

export type SacredQuoteKind = 'quran' | 'hadith';
export type SacredCanonicalStatus = 'matched' | 'mismatch' | 'unchecked';

/** One protected quote of the approved source, as the TE uses it. */
export interface SacredQuote {
  kind: SacredQuoteKind;
  /**
   * The canonical text (S-0, S-5): a verse is the trimmed span WITH its ﴿ ﴾;
   * a hadith is the trimmed inner quote, WITHOUT its quote marks.
   */
  text: string;
  reference: string | null;
  sourceBlockId: string | null;
  /** Hex sha256 of the UTF-8 canonical `text` (recomputed here, never trusted). */
  sha256: string;
  canonicalStatus: SacredCanonicalStatus;
  contentUnitId: string;
  /** `export`: sent by the backend; `detected`: found in the unit text (fallback). */
  origin: 'export' | 'detected';
}

/** What the package stores per source quote (Q-14): never the text itself. */
export type { SacredQuotePin };

/** Owner decision (Q-7, Q-15): narration never reads the quote; it says this instead. */
export const SACRED_NARRATION_LINE: Readonly<Record<SacredQuoteKind, string>> = {
  quran: 'تأمّل الآية المعروضة',
  hadith: 'تأمّل الحديث المعروض',
};

/**
 * F-5: the line an exercise or solution Scene says when the strip emptied its
 * only narration and no verse or hadith is shown any more.
 */
export const EXERCISE_NEUTRAL_LINE = 'خلّنا نحلّ التمرين المعروض';

/**
 * E-10: the same line on a «تأكد» try-it Scene (contentRole
 * check_understanding), which sets the check and never solves it.
 */
export const TRY_IT_NEUTRAL_LINE = 'حاول تحلّ السؤال بنفسك قبل ما نشوف الحل';

/** The gate code a generation pause carries (scene regeneration on resume). */
export const SACRED_TEXT_ALTERED = 'SACRED_TEXT_ALTERED';
/** A ﴿ or ﴾ without its pair on one slide or field: the verse was cut or split. */
export const SACRED_TEXT_SPLIT = 'SACRED_TEXT_SPLIT';
/** An explanation (meaning, tafsir) right after a quote. */
export const SACRED_TEXT_EXPLAINED = 'SACRED_TEXT_EXPLAINED';
/** A quote in a quiz option that is not the exact quote of its stem. */
export const SACRED_TEXT_IN_QUIZ_OPTION = 'SACRED_TEXT_IN_QUIZ_OPTION';
/** A "complete the verse / hadith" item, or a quote with a blank in it. */
export const SACRED_TEXT_COMPLETION_ITEM = 'SACRED_TEXT_COMPLETION_ITEM';
/** Narration or a character's speech reads the quote. */
export const SACRED_TEXT_NARRATED = 'SACRED_TEXT_NARRATED';
/** Audio or video on a slide that shows a quote (no music or sound effects). */
export const SACRED_TEXT_WITH_AUDIO = 'SACRED_TEXT_WITH_AUDIO';
/** Editor refusal: a write changes a pinned quote. */
export const SACRED_TEXT_PINNED = 'SACRED_TEXT_PINNED';
/** The backend's canonical check found a verse whose letters differ from the mushaf (S-6). */
export const SACRED_TEXT_CANONICAL_MISMATCH = 'SACRED_TEXT_CANONICAL_MISMATCH';
/** Owner decision (4 Nov 2026): an exercise or check slide shows a verse or hadith item. */
export const SACRED_TEXT_IN_EXERCISE = 'SACRED_TEXT_IN_EXERCISE';

export interface SacredTextFinding {
  code: string;
  sceneId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

/** ﴿ (U+FD3F) and ﴾ (U+FD3E). Either may open a span; the other closes it. */
const ORNATE_OPEN = '﴿';
const ORNATE_CLOSE = '﴾';
const ORNATE = new Set([ORNATE_OPEN, ORNATE_CLOSE]);
const ORNATE_ANY = /[﴾﴿]/;

/**
 * N-L2 / L-2: the characters a copy may carry without changing what the
 * learner sees — ZWSP, ZWJ, LRM, RLM and the BOM — removed for COMPARISON only
 * (never from shown text or a hash). ZWNJ (U+200C) changes letter joining and
 * the bidi overrides / isolates (U+202A–202E, U+2066–2069) reorder the
 * display, so inside a span they make it differ (ALTERED, never pinned).
 */
const INVISIBLE = /[​‍‎‏﻿]/g;

/**
 * Arabic diacritics, Quranic annotation marks and tatweel (word-run matching
 * only, so a spoken or unbracketed copy is still caught): U+08D3–U+08FF
 * extended marks and every zero-width / bidi control, then U+0610–061A,
 * U+064B–065F, U+0670, U+06D6–06ED and U+0640.
 */
const MARKS = /[࣓-ࣿ​-‏‪-‮⁦-⁩﻿]|[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stripMarks(text: string): string {
  return text.replace(MARKS, '');
}

/** One detected quote in one text. */
export interface SacredSpan {
  kind: SacredQuoteKind;
  start: number;
  /** Exclusive. Covers the brackets of a verse and the quote marks of a hadith. */
  end: number;
  /** The printed span (a hadith with its quote marks). */
  text: string;
  /** The canonical text (S-0): see {@link SacredQuote.text}. */
  canonical: string;
}

/**
 * S-0 verses: brackets are paired sequentially (an opener is either
 * character; the next bracket of the OTHER character closes it). Any bracket
 * that cannot be paired — an odd count, or two of the same character in a
 * row — voids every verse of the text (`unbalanced`, no spans).
 */
export function findVerseSpans(text: string): { spans: SacredSpan[]; unbalanced: boolean } {
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (ORNATE.has(text[index]!)) positions.push(index);
  }
  if (positions.length === 0) return { spans: [], unbalanced: false };
  if (positions.length % 2 === 1) return { spans: [], unbalanced: true };
  const spans: SacredSpan[] = [];
  for (let pair = 0; pair < positions.length; pair += 2) {
    const start = positions[pair]!;
    const close = positions[pair + 1]!;
    if (text[start] === text[close]) return { spans: [], unbalanced: true };
    const span = text.slice(start, close + 1);
    spans.push({ kind: 'quran', start, end: close + 1, text: span, canonical: pyStrip(span) });
  }
  return { spans, unbalanced: false };
}

/**
 * Whitespace exactly as the backend (Python `str.isspace()` / `re` `\s`)
 * sees it: unlike JS `\s` and `trim()`, the BOM (U+FEFF) is NOT whitespace,
 * and U+001C–U+001F and U+0085 ARE.
 */
const PY_WS_CHARS =
  '\\t\\n\\v\\f\\r \\u001C-\\u001F\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const WS = `[${PY_WS_CHARS}]`;
/** Whitespace other than a newline (a blank line is newline, these, newline). */
const WS_NOT_NEWLINE = `[${PY_WS_CHARS.replace('\\n', '')}]`;
const PY_STRIP = new RegExp(`^${WS}+|${WS}+$`, 'gu');

/** Python's `str.strip()` (shared fixture trim rule). */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '');
}

/**
 * A phrase whose letters may each carry harakat, tanween, a shadda, a sukun,
 * a maddah or hamza mark (U+064B–U+0655) or a dagger alef (U+0670), with ٱ
 * accepted wherever ا is written and whitespace between its words: the
 * backend's `_with_marks` (shared S-0 / M-5 / M-2 rule; «رَسُولُ اللّٰهِ»,
 * «صَلَّىٰ», «ٱلنَّبِيُّ»).
 */
function withOptionalMarks(phrase: string): string {
  return [...phrase]
    .map((char) =>
      char === ' ' ? `${WS}+` : `${char === 'ا' ? '[اٱ]' : char}[\\u064B-\\u0655\\u0670]*`,
    )
    .join('');
}

const HONORIFIC = `(?:ﷺ|\\(ﷺ\\)|${withOptionalMarks('صلى الله عليه وسلم')}|${withOptionalMarks('عليه الصلاة والسلام')})`;
const OPTIONAL_HONORIFIC = `(?:${WS}*${HONORIFIC})?`;
const REQUIRED_HONORIFIC = `${WS}*${HONORIFIC}`;
// M-5 (backend `_with_marks`): every attribution word may carry harakat or a
// shadda after each letter, so «قَالَ رَسُولُ اللَّهِ ﷺ: «…»» is detected too.
const SAYS = `(?:${withOptionalMarks('قال')}|${withOptionalMarks('يقول')})`;
const RASUL_ALLAH = withOptionalMarks('رسول الله');
const ALNABI = withOptionalMarks('النبي');
const ALRASUL = withOptionalMarks('الرسول');
const PROPHET_WITH_NABI = `(?:${RASUL_ALLAH}|${ALNABI}|${withOptionalMarks('نبي الله')})`;
const PROPHET = `(?:${RASUL_ALLAH}|${ALNABI})`;
const PROPHET_OR_RASUL = `(?:${ALRASUL}|${ALNABI}|${RASUL_ALLAH})`;

/** S-0 attributions 1–6, in the order of the shared rule. */
const HADITH_ATTRIBUTION = [
  `${SAYS}${WS}+${PROPHET_WITH_NABI}${OPTIONAL_HONORIFIC}`,
  `${withOptionalMarks('أن')}${WS}+${PROPHET}${OPTIONAL_HONORIFIC}${WS}+${SAYS}`,
  `${PROPHET}${REQUIRED_HONORIFIC}${WS}+${SAYS}`,
  `${SAYS}${WS}*ﷺ`,
  `${SAYS}${WS}+${ALRASUL}${REQUIRED_HONORIFIC}`,
  // Sixth form (coordinator decision, 4 Nov): «عن الرسول ﷺ أنه قال».
  `${withOptionalMarks('عن')}${WS}+${PROPHET_OR_RASUL}${REQUIRED_HONORIFIC}${WS}+${withOptionalMarks('أنه')}${WS}+${SAYS}`,
].join('|');

/**
 * The quote pairs of the rule, each with an inner of 2–800 characters and no
 * blank line. The inner ends at the FIRST closing mark (a nested opener is
 * inner text, as in the shared fixture).
 */
const HADITH_QUOTES: ReadonlyArray<readonly [string, string, string]> = [
  ['«', '»', '[^»]'],
  ['"', '"', '[^"]'],
  ['“', '”', '[^”]'],
];
const HADITH_RE = new RegExp(
  `(?:${HADITH_ATTRIBUTION})${WS}*[:،]?${WS}*(?:${HADITH_QUOTES.map(
    ([open, close, inner], index) =>
      `(?<q${index}>${open}(?<t${index}>(?:(?!\\n${WS_NOT_NEWLINE}*\\n)${inner}){2,800})${close})`,
  ).join('|')})`,
  'gu',
);

/** S-0 hadith: attributed quotes; a quote overlapping a verse span is not a hadith. */
export function findHadithSpans(
  text: string,
  verses: readonly SacredSpan[] = findVerseSpans(text).spans,
): SacredSpan[] {
  const spans: SacredSpan[] = [];
  for (const match of text.matchAll(HADITH_RE)) {
    const groups = match.groups ?? {};
    const index = HADITH_QUOTES.findIndex((_, quote) => groups[`q${quote}`] !== undefined);
    if (index < 0) continue;
    const quoted = groups[`q${index}`]!;
    const canonical = pyStrip(groups[`t${index}`]!);
    const end = (match.index ?? 0) + match[0].length;
    const start = end - quoted.length;
    if (canonical === '') continue;
    if (verses.some((verse) => verse.start < end && start < verse.end)) continue;
    spans.push({ kind: 'hadith', start, end, text: quoted, canonical });
  }
  return spans;
}

/** Every verse and hadith of one text, in reading order (S-0). */
export function findSacredSpans(text: string): { spans: SacredSpan[]; unbalanced: boolean } {
  const verses = findVerseSpans(text);
  const spans = [...verses.spans, ...findHadithSpans(text, verses.spans)].sort(
    (a, b) => a.start - b.start,
  );
  return { spans, unbalanced: verses.unbalanced };
}

/** The shared contract view (S-0 fixture): `{kind, text}` per quote, in reading order. */
export function detectSacredText(text: string): Array<{ kind: SacredQuoteKind; text: string }> {
  return findSacredSpans(text).spans.map((span) => ({ kind: span.kind, text: span.canonical }));
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = HADITH_QUOTES.map(
  ([open, close]) => [open, close] as const,
);

/** The canonical form of a quote text (S-5): what pins and prompts use. */
export function canonicalQuoteText(kind: SacredQuoteKind, text: string): string {
  const value = pyStrip(text);
  if (kind === 'quran') return value;
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      return pyStrip(value.slice(open.length, value.length - close.length));
    }
  }
  return value;
}

/** The comparable words of a quote: a verse without its brackets, a hadith as is. */
function quoteInner(kind: SacredQuoteKind, canonical: string): string {
  if (kind === 'hadith') return canonical;
  return canonical
    .replace(/^[﴾﴿]\s*/, '')
    .replace(/\s*[﴾﴿]$/, '')
    .trim();
}

const ELLIPSIS = /…|\.{3,}/;
const BLANK = /_{2,}|\(\s*\)|\.\s\.\s\./;
const EDGE_PUNCTUATION = /^[،؛:.!؟?,;()«»"“”]+|[،؛:.!؟?,;()«»"“”]+$/g;

function tokensOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => token !== '');
}

/**
 * S-6 cut: whole-word pieces of at least two words, in source order, with an
 * ellipsis allowed at the start, at the end, and at most once inside. A piece
 * that does not start (end) the source needs an ellipsis before (after) it.
 */
function isFaithfulCut(inner: string, sourceInner: string): boolean {
  const parts = inner.split(ELLIPSIS);
  if (parts.length < 2) return false;
  const leading = parts[0]!.trim() === '';
  const trailing = parts[parts.length - 1]!.trim() === '';
  const pieces = parts.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  if (pieces.length === 0 || pieces.length > 2) return false;
  if (pieces.some((piece) => piece.trim() === '')) return false;
  const pieceTokens = pieces.map((piece) => tokensOf(piece.replace(INVISIBLE, '')));
  if (pieceTokens.some((tokens) => tokens.length < 2)) return false;
  // N-H1: a source that is itself a cut keeps each of its ellipses as a
  // barrier token, so a cut of it can never close the source's own gap (an
  // ASCII "..." would otherwise vanish with the edge punctuation).
  // L-1: every printed ellipsis form («…», «‥», «...», «. . .»).
  const source = tokensOf(
    sourceInner.replace(INVISIBLE, '').replace(/…|‥|\.{3,}|(?:\.\s){2,}\./g, ' … '),
  );
  const at = (tokens: string[], from: number): number[] => {
    const hits: number[] = [];
    for (let index = from; index + tokens.length <= source.length; index += 1) {
      if (tokens.every((token, offset) => source[index + offset] === token)) hits.push(index);
    }
    return hits;
  };
  for (const first of at(pieceTokens[0]!, 0)) {
    if (!leading && first !== 0) continue;
    const firstEnd = first + pieceTokens[0]!.length;
    if (pieceTokens.length === 1) {
      if (trailing || firstEnd === source.length) return true;
      continue;
    }
    // The inner ellipsis stands for at least one removed word.
    for (const second of at(pieceTokens[1]!, firstEnd + 1)) {
      const secondEnd = second + pieceTokens[1]!.length;
      if (trailing || secondEnd === source.length) return true;
    }
  }
  return false;
}

/**
 * M-4: every whitespace run as one space, for COMPARISON only. A verse the
 * model wraps with `<br>` (or a source with an OCR line break) is the same
 * text. Pins and hashes stay on the raw canonical text; a shown variant that
 * differs only here is pinned by its own raw hash ({@link usedSacredQuotePins}).
 */
const WS_RUN = new RegExp(`${WS}+`, 'gu');
const WS_INSIDE_OPEN = new RegExp(`^([﴾﴿«"“])${WS}+`, 'u');
const WS_INSIDE_CLOSE = new RegExp(`${WS}+([﴾﴿»"”])$`, 'u');

/**
 * Comparison form (M-4, N-L2): invisible characters removed, whitespace runs
 * as one space, the text trimmed, and no space just inside its brackets.
 */
function collapseWhitespace(text: string): string {
  return pyStrip(text.replace(INVISIBLE, '').replace(WS_RUN, ' '))
    .replace(WS_INSIDE_OPEN, '$1')
    .replace(WS_INSIDE_CLOSE, '$1');
}

/** Does a package span equal ONE source quote (modulo whitespace), or cut it faithfully (S-6)? */
function spanMatches(span: SacredSpan, source: string): boolean {
  if (collapseWhitespace(span.canonical) === collapseWhitespace(source)) return true;
  const inner = quoteInner(span.kind, span.canonical);
  return ELLIPSIS.test(inner) && isFaithfulCut(inner, quoteInner(span.kind, source));
}

/** Does a package span equal a source quote exactly, or cut it faithfully (S-6)? */
function matchesSource(span: SacredSpan, sources: readonly string[]): boolean {
  return sources.some((source) => spanMatches(span, source));
}

/** Every «…», "…" or “…” pair (inner 2–800 characters, no blank line), attributed or not. */
const QUOTE_PAIR_RE = new RegExp(
  HADITH_QUOTES.map(
    ([open, close, inner]) => `${open}((?:(?!\\n${WS_NOT_NEWLINE}*\\n)${inner}){2,800})${close}`,
  ).join('|'),
  'gu',
);

/** The quote pairs of a text whose trimmed inner text passes `accept`, as hadith spans. */
function quotePairSpans(
  text: string,
  taken: readonly SacredSpan[],
  accept: (canonical: string) => boolean,
): SacredSpan[] {
  const spans: SacredSpan[] = [];
  for (const match of text.matchAll(QUOTE_PAIR_RE)) {
    const inner = match[1] ?? match[2] ?? match[3];
    if (inner === undefined) continue;
    const canonical = pyStrip(inner);
    if (canonical === '' || !accept(canonical)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (taken.some((span) => span.start < end && start < span.end)) continue;
    spans.push({ kind: 'hadith', start, end, text: match[0], canonical });
  }
  return spans;
}

/**
 * The spans of one shown text: the S-0 spans, plus (M-6) an exact source
 * hadith shown inside a quote pair WITHOUT its attribution — an exact span,
 * not an altered copy.
 */
function shownSpans(
  text: string,
  hadithSources: readonly string[],
): { spans: SacredSpan[]; unbalanced: boolean } {
  const found = findSacredSpans(text);
  if (hadithSources.length === 0) return found;
  const wanted = new Set(hadithSources.map(collapseWhitespace));
  const extra = quotePairSpans(text, found.spans, (canonical) =>
    wanted.has(collapseWhitespace(canonical)),
  );
  if (extra.length === 0) return found;
  return {
    spans: [...found.spans, ...extra].sort((a, b) => a.start - b.start),
    unbalanced: found.unbalanced,
  };
}

// ---------------------------------------------------------------------------
// Input: the export field, or detection on older backends
// ---------------------------------------------------------------------------

/** One `sacred_quotes` entry as the backend exports it (Q-3 contract, additive). */
export interface SacredQuoteWire {
  kind: SacredQuoteKind;
  /** The exact span; a Quran quote includes its ﴿ ﴾, a hadith has no quote marks. */
  text: string;
  reference?: string | null;
  source_block_id?: number | string | null;
  /** Hex sha256 of the UTF-8 text (recomputed by the TE). */
  sha256?: string;
  canonical_status?: SacredCanonicalStatus;
}

/** The unit fields this module reads (the manifest unit, untyped extras included). */
export interface SacredSourceUnit {
  id: string;
  normalizedText?: string;
  blocks?: ReadonlyArray<{ id: string; text?: string }>;
  sacred_quotes?: unknown;
  sacredQuotes?: unknown;
}

export class SacredQuotesContractError extends Error {
  constructor(readonly unitId: string) {
    super(`content unit ${unitId} carries a malformed sacred_quotes field`);
    this.name = 'SacredQuotesContractError';
  }
}

const KINDS: ReadonlySet<string> = new Set(['quran', 'hadith']);
const STATUSES: ReadonlySet<string> = new Set(['matched', 'mismatch', 'unchecked']);

function wireQuotes(unit: SacredSourceUnit): unknown[] | undefined {
  const value = unit.sacred_quotes !== undefined ? unit.sacred_quotes : unit.sacredQuotes;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new SacredQuotesContractError(String(unit.id));
  return value;
}

function parseWireQuote(raw: unknown, unitId: string): SacredQuote {
  const record = raw as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') throw new SacredQuotesContractError(unitId);
  const kind = record.kind;
  const text = record.text;
  const reference = record.reference;
  const blockId = record.source_block_id ?? record.sourceBlockId;
  const status = record.canonical_status ?? record.canonicalStatus ?? 'unchecked';
  if (
    typeof kind !== 'string' ||
    !KINDS.has(kind) ||
    typeof text !== 'string' ||
    text.trim() === '' ||
    (reference !== undefined && reference !== null && typeof reference !== 'string') ||
    (blockId !== undefined &&
      blockId !== null &&
      typeof blockId !== 'string' &&
      !Number.isSafeInteger(blockId)) ||
    typeof status !== 'string' ||
    !STATUSES.has(status)
  ) {
    throw new SacredQuotesContractError(unitId);
  }
  const canonical = canonicalQuoteText(kind as SacredQuoteKind, text);
  if (canonical === '') throw new SacredQuotesContractError(unitId);
  return {
    kind: kind as SacredQuoteKind,
    text: canonical,
    reference: typeof reference === 'string' && reference.trim() !== '' ? reference : null,
    sourceBlockId: blockId === undefined || blockId === null ? null : String(blockId),
    // The text is the authority; a differing wire digest never replaces it.
    sha256: sha256Hex(canonical),
    canonicalStatus: status as SacredCanonicalStatus,
    contentUnitId: String(unitId),
    origin: 'export',
  };
}

/** «سورة آل عمران الآية: 7» right after a verse (detection fallback only). */
const QURAN_REFERENCE =
  /^[\s)(\]\[،.:-]*(\(?\s*سورة\s+[^\n()]{1,40}?(?:الآية|آية)\s*[:：]?\s*[\d٠-٩]+\s*\)?)/u;

function blockIdFor(unit: SacredSourceUnit, span: string): string | null {
  const block = (unit.blocks ?? []).find((candidate) => (candidate.text ?? '').includes(span));
  return block ? String(block.id) : null;
}

/** Older backends: the unit text's verses and attributed hadith, by the S-0 rule. */
export function detectSacredQuotes(unit: SacredSourceUnit): SacredQuote[] {
  const text = unit.normalizedText ?? '';
  return findSacredSpans(text).spans.map((span) => {
    const reference =
      span.kind === 'quran'
        ? (QURAN_REFERENCE.exec(stripMarks(text.slice(span.end, span.end + 120)))?.[1]?.trim() ??
          null)
        : null;
    return {
      kind: span.kind,
      text: span.canonical,
      reference,
      sourceBlockId: blockIdFor(unit, span.text),
      sha256: sha256Hex(span.canonical),
      canonicalStatus: 'unchecked' as const,
      contentUnitId: String(unit.id),
      origin: 'detected' as const,
    };
  });
}

/**
 * The run's protected quotes, in unit order. A unit that carries the field
 * (even empty) is trusted; a unit without it is detected. A malformed field
 * throws {@link SacredQuotesContractError} (fail closed).
 */
export function sacredQuotesFromManifest(units: ReadonlyArray<SacredSourceUnit>): SacredQuote[] {
  const quotes: SacredQuote[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    const wire = wireQuotes(unit);
    const unitQuotes =
      wire === undefined
        ? detectSacredQuotes(unit)
        : wire.map((raw) => parseWireQuote(raw, String(unit.id)));
    for (const quote of unitQuotes) {
      const key = `${quote.contentUnitId}\u0000${quote.kind}\u0000${quote.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      quotes.push(quote);
    }
  }
  return quotes;
}

/**
 * Owner decision S-9: the subject route keys whose runs always carry the full
 * policy block. Literary Studies routes as ARABIC too (backend subject code).
 * Islamic studies has no route key today, so it reaches the full block through
 * its quotes only.
 */
const FULL_POLICY_SUBJECT_CODES: ReadonlySet<string> = new Set(['ARABIC']);

/**
 * S-9: `full` (the whole policy block and the quote list) when the lesson has
 * protected quotes or its subject route key is ARABIC; `short` (one line,
 * "never invent a verse or hadith") for every other run.
 */
export function sacredPolicyMode(
  quotes: readonly unknown[],
  subjectCode: string | null | undefined,
): 'full' | 'short' {
  if (quotes.length > 0) return 'full';
  const code = typeof subjectCode === 'string' ? subjectCode.trim().toUpperCase() : '';
  return FULL_POLICY_SUBJECT_CODES.has(code) ? 'full' : 'short';
}

/**
 * S-9 for the TE-owned prompts (bank questions, book-question enrichment, the
 * inserted-slide planner): `full` when the package pins any book quote, the
 * lesson texts hold a verse or attributed hadith, or the subject is ARABIC.
 */
export function sacredPolicyModeFor(input: {
  subjectCode: string | null | undefined;
  pins?: readonly unknown[] | null;
  texts?: ReadonlyArray<string | null | undefined>;
}): 'full' | 'short' {
  if ((input.pins?.length ?? 0) > 0) return 'full';
  const found = (input.texts ?? []).some(
    (text) => typeof text === 'string' && findSacredSpans(text).spans.length > 0,
  );
  return sacredPolicyMode(found ? [true] : [], input.subjectCode);
}

/** S-6: the quotes the backend's canonical check flagged; a run with any fails closed. */
export function canonicalMismatchQuotes(quotes: readonly SacredQuote[]): SacredQuote[] {
  return quotes.filter((quote) => quote.canonicalStatus === 'mismatch');
}

/**
 * The prompt view of the quotes (Q-4): text, reference and unit, nothing
 * internal. A hadith is shown inside «» so the model prints it as a quote
 * (and the validator detects it after its attribution).
 */
export function sacredQuotesForPrompt(quotes: readonly SacredQuote[]): Array<{
  kind: SacredQuoteKind;
  text: string;
  reference: string | null;
  contentUnitId?: string;
}> {
  // A quote with no unit (a PDF fallback source) is offered to every scene.
  return quotes.map((quote) => ({
    kind: quote.kind,
    text: quote.kind === 'hadith' ? `«${quote.text}»` : quote.text,
    reference: quote.reference,
    ...(quote.contentUnitId ? { contentUnitId: quote.contentUnitId } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Scene text extraction
// ---------------------------------------------------------------------------

/** The Scene fields the checks read (an AppScene satisfies it). */
export interface SacredSceneLike {
  id: string;
  type?: string;
  title?: string;
  content?: unknown;
  actions?: unknown;
}

/** Keys whose string values are never learner-facing text. */
const NON_TEXT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'src',
  'path',
  'viewBox',
  'fill',
  'color',
  'fontName',
  'defaultFontName',
  'defaultColor',
  'elementId',
  'audioId',
  'voice',
  'poster',
  'url',
  'href',
]);

const ENTITY: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** Visible text of an HTML fragment: block tags break lines, inline tags vanish. */
export function htmlToText(value: string): string {
  if (!value.includes('<') && !value.includes('&')) return value;
  return value
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (entity) => ENTITY[entity] ?? entity)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function collectStrings(value: unknown, into: string[], key?: string): void {
  if (typeof value === 'string') {
    if (key && NON_TEXT_KEYS.has(key)) return;
    if (value.trim() !== '') into.push(htmlToText(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, into, childKey);
    }
  }
}

function stringsOf(value: unknown): string[] {
  const out: string[] = [];
  collectStrings(value, out);
  return out;
}

interface QuizItem {
  stem: string;
  options: string[];
  other: string[];
}

interface SceneText {
  /** One joined text per display surface (a slide's canvas, a whiteboard text). */
  display: string[];
  practice: string[];
  quiz: QuizItem[];
  spoken: string[];
  /** The slide has an audio or video element, or plays a video. */
  hasAudio: boolean;
}

function actionsOf(scene: SacredSceneLike): Array<Record<string, unknown>> {
  return Array.isArray(scene.actions)
    ? (scene.actions as unknown[]).filter(
        (action): action is Record<string, unknown> => !!action && typeof action === 'object',
      )
    : [];
}

/** S-6: every whiteboard action that draws or edits learner-visible content. */
function isWhiteboardContent(type: unknown): boolean {
  return typeof type === 'string' && (type.startsWith('wb_draw_') || type.startsWith('wb_edit_'));
}

/** L-3: widget actions whose `content` the widget frame shows the learner. */
const WIDGET_TEXT_ACTIONS: ReadonlySet<string> = new Set([
  'widget_annotation',
  'widget_reveal',
  'widget_highlight',
]);

function sceneText(scene: SacredSceneLike): SceneText {
  const out: SceneText = { display: [], practice: [], quiz: [], spoken: [], hasAudio: false };
  // S-6: the Scene title is shown to the learner too.
  if (typeof scene.title === 'string' && scene.title.trim() !== '') {
    out.display.push(htmlToText(scene.title));
  }
  const content = (scene.content ?? {}) as Record<string, unknown>;
  if (scene.type === 'slide' || (content && typeof content === 'object' && 'canvas' in content)) {
    const canvas = (content.canvas ?? {}) as Record<string, unknown>;
    const elements = Array.isArray(canvas.elements) ? (canvas.elements as unknown[]) : [];
    // The whole canvas is ONE surface: a verse split between two of its text
    // boxes is still one span, and a bracket left open is a cut verse.
    out.display.push(elements.map((element) => stringsOf(element).join(' ')).join('\n'));
    out.hasAudio = elements.some((element) => {
      const type = (element as { type?: unknown } | null)?.type;
      return type === 'audio' || type === 'video';
    });
    const { canvas: _canvas, ...rest } = content;
    out.practice.push(...stringsOf(rest));
  } else if (scene.type === 'quiz' || Array.isArray(content.questions)) {
    const questions = Array.isArray(content.questions) ? (content.questions as unknown[]) : [];
    for (const question of questions) {
      const record = (question ?? {}) as Record<string, unknown>;
      const options = Array.isArray(record.options) ? (record.options as unknown[]) : [];
      out.quiz.push({
        stem: typeof record.question === 'string' ? htmlToText(record.question) : '',
        options: options.map((option) => stringsOf(option).join(' ')),
        other: [
          ...stringsOf(record.analysis),
          ...stringsOf(record.commentPrompt),
          ...stringsOf(record.answer),
        ],
      });
    }
  } else {
    out.practice.push(...stringsOf(content));
  }
  for (const action of actionsOf(scene)) {
    if (action.type === 'speech' && typeof action.text === 'string') out.spoken.push(action.text);
    else if (action.type === 'discussion') {
      for (const key of ['topic', 'prompt'] as const) {
        if (typeof action[key] === 'string') out.spoken.push(action[key] as string);
      }
    } else if (isWhiteboardContent(action.type)) {
      out.display.push(stringsOf(action).join(' '));
    } else if (WIDGET_TEXT_ACTIONS.has(action.type as string)) {
      // L-3: the widget posts this `content` into its frame for the learner.
      if (typeof action.content === 'string' && action.content.trim() !== '') {
        out.display.push(htmlToText(action.content));
      }
    } else if (action.type === 'play_video') out.hasAudio = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation (Q-5, Q-7, Q-10, Q-12, Q-13, S-2, S-3)
// ---------------------------------------------------------------------------

/** S-3: only directly after the closing bracket (or quote mark). */
const EXPLANATION_DIRECTLY_AFTER = [/^\s*أي\s*[:：]/u, /^\s*\(?i\.e\./i];
/** S-3: within the same sentence, about 40 characters after the quote. */
const EXPLANATION_AFTER = [
  /معنى\s+(?:هذه\s+)?(?:الآية|الآيه|الحديث|قوله)/u,
  /يقصد\s+بها/u,
  /\bthe (?:verse|hadith) means\b/i,
];
/** Anywhere in a Scene that shows a quote, or in its narration. */
const EXPLANATION_ANYWHERE = [
  /معنى\s+(?:هذه\s+)?(?:الآية|الآيه|الحديث)/u,
  /تفسير\s+(?:هذه\s+)?(?:الآية|الآيه|الحديث)/u,
  /شرح\s+(?:هذا\s+)?الحديث/u,
  /المراد\s+(?:ب|من\s+)(?:هذه\s+)?(?:الآية|الآيه|الحديث)/u,
  /سبب\s+نزول/u,
];
/** «أكمل» in its spellings, «أتمم», «تكملة» (MEDIUM-2; matched on mark-stripped text). */
const COMPLETE_WORD = '(?:[اأإآ]كمل(?:ي|وا)?|[أا]تمم(?:ي|وا)?|تكملة)';
/** "Complete the verse(s)" or «أكمل قوله تعالى»: always a completion item. */
const VERSE_COMPLETION_ITEM = [
  new RegExp(`${COMPLETE_WORD}\\s+(?:ال)?[اآ]ي(?:ة|ه|ات)(?![\\p{L}])`, 'u'),
  // «أكمل قوله تعالى», «أكمل قول الله تعالى», «أكمل قوله سبحانه».
  new RegExp(
    `${COMPLETE_WORD}\\s+قول(?:ه|\\s+[اٱ]لله)\\s+(?:تعال[ىي]|سبحانه|عز\\s+وجل|تبارك)`,
    'u',
  ),
  /\bcomplete the (?:verse|ayah)\b/i,
];
/**
 * "Complete the hadith" (H-1, MEDIUM-3): «حديث» is also an ordinary word
 * («أكمل الحديث بين الصديقين», «أكمل حديثك»), so this half counts only with a
 * hadith context of its own field ({@link hadithCompletionContext}).
 */
const HADITH_COMPLETION_ITEM = [
  new RegExp(`${COMPLETE_WORD}\\s+(?:ال)?حديث`, 'u'),
  /\bcomplete the hadith\b/i,
];
/** The phrase itself names the Prophet's hadith (MEDIUM-3). */
const NAMED_HADITH = /(?:ال)?حديث\s+(?:الشريف|النبوي|النبي|الرسول|رسول\s+الله)/u;
const EXPLANATION_WINDOW = 40;
/** S-2 / S-4: this many consecutive words of a quote are a copy of it. */
const QUOTE_RUN_WORDS = 5;

function explainedAfter(text: string, end: number): boolean {
  const after = stripMarks(text.slice(end));
  if (EXPLANATION_DIRECTLY_AFTER.some((pattern) => pattern.test(after))) return true;
  // Same element and sentence: stop at a newline or «.».
  const window = after.slice(0, EXPLANATION_WINDOW);
  const stop = window.search(/[\n.]/);
  const sentence = stop >= 0 ? window.slice(0, stop) : window;
  return EXPLANATION_AFTER.some((pattern) => pattern.test(sentence));
}

function explainedAnywhere(text: string): boolean {
  const plain = stripMarks(text);
  return EXPLANATION_ANYWHERE.some((pattern) => pattern.test(plain));
}

/**
 * H-1 letter fold, for word-run MATCHING only (never shown text, a canonical
 * text or a hash): the backend S-7 skeleton idea applied per word, so the
 * mushaf (Uthmani) spelling of a verse and its normal spelling compare equal.
 * The light fold unifies alef forms, «ى», «ة» and Persian yeh / keheh and
 * drops digits (verse numbers). The skeleton fold (N-M3: Uthmani quotes, five-
 * word runs only) also drops every hamza seat (ء ؤ ئ) and the weak letters
 * ا و ي, because the two spellings differ mostly there («هَٰرُونُ» / «هارون»,
 * «ٱلصَّلَوٰةَ» / «الصلاة», «ٱلْمَلَـٰٓئِكَةُ» / «الملائكة»). The aya sign ۝ is a
 * mark (stripped with the harakat). A word left empty is dropped on both sides.
 */
const LETTER_FOLD: Readonly<Record<string, string>> = {
  ٱ: 'ا',
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ى: 'ي',
  ة: 'ه',
  ی: 'ي',
  ک: 'ك',
};
const FOLDED_LETTERS = /[ٱأإآىةیک]/g;
/** Light fold (every quote): verse digits and the rub-el-hizb sign. */
const DROPPED_LIGHT = /[0-9٠-٩۰-۹۞]/g;
/** Skeleton fold (N-M3: Uthmani quotes of five words or more only): seats and weak letters too. */
const DROPPED_SKELETON = /[ءؤئاوي]/g;
/** ٱ, the dagger alef, small waw and small yeh: the quote is printed in mushaf spelling. */
const UTHMANI_MARKERS = /[ٱٰۥۦ]/;

type FoldMode = 'light' | 'skeleton';

function foldWord(word: string, mode: FoldMode): string {
  const light = word
    .replace(FOLDED_LETTERS, (char) => LETTER_FOLD[char] ?? char)
    .replace(DROPPED_LIGHT, '');
  return mode === 'skeleton' ? light.replace(DROPPED_SKELETON, '') : light;
}

function wordsOf(text: string, mode: FoldMode): string[] {
  return stripMarks(text)
    .replace(/[﴾﴿«»"'“”،؛:.!؟?,;()[\]{}-]/g, ' ')
    .split(/\s+/)
    .map((word) => foldWord(word, mode))
    .filter((word) => word !== '');
}

/**
 * Each run (its folded words joined by one space) with its kind:
 * - `light`: light-folded runs, compared with any text;
 * - `skeleton`: skeleton runs of Uthmani quotes, compared with any text;
 * - `uthmaniText`: skeleton runs of EVERY quote, compared only with a text
 *   that itself shows Uthmani markers (B-1: a normal-spelling source spoken in
 *   mushaf spelling).
 */
interface QuoteRuns {
  light: ReadonlyMap<string, SacredQuoteKind>;
  skeleton: ReadonlyMap<string, SacredQuoteKind>;
  uthmaniText: ReadonlyMap<string, SacredQuoteKind>;
}

/** Shortest quote (in words) a speech check takes whole by its skeleton (B-1). */
const SHORT_SKELETON_WORDS = 3;

function addRuns(into: Map<string, SacredQuoteKind>, words: string[], kind: SacredQuoteKind) {
  for (let index = 0; index + QUOTE_RUN_WORDS <= words.length; index += 1) {
    into.set(words.slice(index, index + QUOTE_RUN_WORDS).join(' '), kind);
  }
}

/**
 * The consecutive-word runs of every quote, each with its kind. `shortWhole`
 * also takes a quote shorter than five words whole (2+ words): speech only.
 *
 * N-M3: the skeleton fold (no hamza seats, no ا و ي) is used for a quote
 * printed in Uthmani spelling; a quote in normal spelling uses the light fold,
 * so particles cannot make ordinary narration match. B-1: in speech, a short
 * Uthmani quote of three words or more is ALSO taken whole by its skeleton
 * («ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ» / «الحمد لله رب العالمين»): a false
 * positive there only replaces one sentence with the owner's line.
 */
function quoteRuns(quotes: readonly SacredQuote[], shortWhole: boolean): QuoteRuns {
  const runs = {
    light: new Map<string, SacredQuoteKind>(),
    skeleton: new Map<string, SacredQuoteKind>(),
    uthmaniText: new Map<string, SacredQuoteKind>(),
  };
  for (const quote of quotes) {
    const inner = quoteInner(quote.kind, quote.text);
    const uthmani = UTHMANI_MARKERS.test(inner);
    const light = wordsOf(inner, 'light');
    const skeleton = wordsOf(inner, 'skeleton');
    if (uthmani && skeleton.length >= QUOTE_RUN_WORDS) addRuns(runs.skeleton, skeleton, quote.kind);
    else addRuns(runs.light, light, quote.kind);
    addRuns(runs.uthmaniText, skeleton, quote.kind);
    if (!shortWhole || light.length >= QUOTE_RUN_WORDS) continue;
    if (light.length >= 2) runs.light.set(light.join(' '), quote.kind);
    if (light.length >= SHORT_SKELETON_WORDS && skeleton.length >= 2) {
      if (uthmani) runs.skeleton.set(skeleton.join(' '), quote.kind);
      runs.uthmaniText.set(skeleton.join(' '), quote.kind);
    }
  }
  return runs;
}

/** The kind of the first quote run the text holds, or `null`. */
function runIn(text: string, runs: QuoteRuns): SacredQuoteKind | null {
  const checks: Array<[ReadonlyMap<string, SacredQuoteKind>, FoldMode]> = [
    [runs.light, 'light'],
    [runs.skeleton, 'skeleton'],
  ];
  if (UTHMANI_MARKERS.test(text)) checks.push([runs.uthmaniText, 'skeleton']);
  for (const [map, mode] of checks) {
    if (map.size === 0) continue;
    const padded = ` ${wordsOf(text, mode).join(' ')} `;
    for (const [run, kind] of map) if (padded.includes(` ${run} `)) return kind;
  }
  return null;
}

/**
 * L-4 (owner rule): a spoken sentence introduced as a verse («قال تعالى»,
 * «قوله تعالى», «يقول الله تعالى») or as the Prophet's words («قال ﷺ», «قال
 * رسول الله ﷺ») reads one, even with no bracket and no known quote.
 */
// Matched on mark- and tatweel-stripped text (LOW-2), so harakat never hide them.
const SPOKEN_VERSE_INTRO = [
  new RegExp(
    `(?:قال|قوله|يقول)(?:${WS}+(?:[اٱ]ل(?:له|حق)|رب(?:نا|كم)))?${WS}+(?:تعال[ىي]|سبحانه(?:${WS}+وتعال[ىي])?|عز${WS}+وجل|تبارك${WS}+وتعال[ىي])`,
    'u',
  ),
  // «قال الله:», «يقول الله في كتابه:», «قال ربنا:» — only right before a colon,
  // a quote mark or a verse bracket, so «قال الله في هذا الدرس» is not one.
  new RegExp(
    `(?:قال|يقول)${WS}+(?:[اٱ]لله|رب(?:نا|كم))(?:${WS}+(?:عز${WS}+وجل|سبحانه(?:${WS}+وتعال[ىي])?|تبارك${WS}+وتعال[ىي]))?(?:${WS}+في${WS}+(?:كتابه(?:${WS}+[اٱ]ل(?:عزيز|كريم))?|سورة${WS}+\\p{L}+(?:${WS}+\\p{L}+)?|محكم${WS}+(?:[اٱ]لتنزيل|كتابه)))?${WS}*[:：«"“﴿]`,
    'u',
  ),
];
const SPOKEN_HADITH_INTRO = [
  new RegExp(`${SAYS}${WS}*(?:${PROPHET}${WS}*)?${HONORIFIC}`, 'u'),
  // Without the honorific, only right before a colon or a quote mark (LOW-2).
  new RegExp(`(?:قال|يقول)${WS}+(?:رسول${WS}+[اٱ]لله|[اٱ]لنبي)${WS}*[:：«"“]`, 'u'),
];

/**
 * L-4 / LOW-1 / LOW-2: the verse or hadith introduction a spoken text holds,
 * and whether anything quotable (a letter) follows it in the same text.
 */
function spokenIntro(text: string): { kind: SacredQuoteKind; trailing: boolean } | null {
  const plain = stripMarks(text);
  const verse = SPOKEN_VERSE_INTRO.map((re) => re.exec(plain)).find(Boolean) ?? null;
  const hadith = verse ? null : SPOKEN_HADITH_INTRO.map((re) => re.exec(plain)).find(Boolean);
  const match = verse ?? hadith;
  if (!match) return null;
  const rest = plain.slice(match.index + match[0].length);
  return { kind: verse ? 'quran' : 'hadith', trailing: /\p{L}/u.test(rest) };
}

/**
 * S-4: the ONE predicate of the narration check and of its repair. A spoken
 * text reads a quote when it holds a verse bracket, an attributed hadith, a
 * verse or hadith introduction (L-4), or a run of a quote's words. Returns the
 * kind it reads, or `null`.
 */
function spokenQuoteKind(text: string, runs: QuoteRuns): SacredQuoteKind | null {
  if (ORNATE_ANY.test(text)) return 'quran';
  if (findHadithSpans(text, []).length > 0) return 'hadith';
  const intro = spokenIntro(text);
  if (intro) return intro.kind;
  return runIn(text, runs);
}

interface SourceSets {
  quran: string[];
  hadith: string[];
}

function sourceSets(quotes: readonly SacredQuote[]): SourceSets {
  return {
    quran: quotes.filter((quote) => quote.kind === 'quran').map((quote) => quote.text),
    hadith: quotes.filter((quote) => quote.kind === 'hadith').map((quote) => quote.text),
  };
}

interface FieldResult {
  codes: Set<string>;
  /** The canonical quote spans this field shows. */
  spans: string[];
}

/** The text with every detected span blanked out (S-2 looks only outside them). */
function outsideSpans(text: string, spans: readonly SacredSpan[]): string {
  let out = text;
  for (const span of [...spans].reverse()) {
    out = `${out.slice(0, span.start)}\n${out.slice(span.end)}`;
  }
  return out;
}

function checkShownText(text: string, sources: SourceSets, runs: QuoteRuns): FieldResult {
  const codes = new Set<string>();
  const found = shownSpans(text, sources.hadith);
  if (found.unbalanced) codes.add(SACRED_TEXT_SPLIT);
  for (const span of found.spans) {
    if (BLANK.test(span.text)) codes.add(SACRED_TEXT_COMPLETION_ITEM);
    else if (!matchesSource(span, sources[span.kind])) codes.add(SACRED_TEXT_ALTERED);
    if (explainedAfter(text, span.end)) codes.add(SACRED_TEXT_EXPLAINED);
  }
  // S-2: a copy outside an exact span («قال تعالى: …» without brackets, a
  // paraphrase that keeps five words in a row) is an altered quote.
  if (runIn(outsideSpans(text, found.spans), runs)) codes.add(SACRED_TEXT_ALTERED);
  const plain = stripMarks(text);
  if (
    VERSE_COMPLETION_ITEM.some((pattern) => pattern.test(plain)) ||
    (HADITH_COMPLETION_ITEM.some((pattern) => pattern.test(plain)) &&
      hadithCompletionContext(text, plain, found.spans, sources))
  ) {
    codes.add(SACRED_TEXT_COMPLETION_ITEM);
  }
  return { codes, spans: found.spans.map((span) => span.canonical) };
}

/**
 * MEDIUM-3: a "complete the hadith" phrase is a completion item only when its
 * OWN field shows a hadith span, names the Prophet's hadith («الحديث الشريف»,
 * «حديث النبي» …), or holds a source hadith's words (three in a row, or a
 * shorter hadith whole). A
 * bare «أكمل الحديث» elsewhere in a lesson that has hadith is a dialogue.
 */
function hadithCompletionContext(
  text: string,
  plain: string,
  spans: readonly SacredSpan[],
  sources: SourceSets,
): boolean {
  if (spans.some((span) => span.kind === 'hadith')) return true;
  if (NAMED_HADITH.test(plain)) return true;
  // A source hadith's words: three in a row, or a shorter hadith whole.
  const padded = ` ${wordsOf(text, 'light').join(' ')} `;
  return sources.hadith.some((source) => {
    const words = wordsOf(source, 'light');
    const size = Math.min(HADITH_CONTEXT_WORDS, words.length);
    if (size < 2) return false;
    for (let index = 0; index + size <= words.length; index += 1) {
      if (padded.includes(` ${words.slice(index, index + size).join(' ')} `)) return true;
    }
    return false;
  });
}

/** Consecutive source-hadith words that make a "complete the hadith" phrase real. */
const HADITH_CONTEXT_WORDS = 3;

/** Every learner-visible text of one Scene (display, practice, quiz fields). */
function shownFields(text: SceneText): string[] {
  return [
    ...text.display,
    ...text.practice,
    ...text.quiz.flatMap((item) => [item.stem, ...item.options, ...item.other]),
  ];
}

/**
 * L-1 / M-2: the kind of the first quote a Scene shows, or `null`. The ONE
 * "shows a quote" predicate of the check and of the narration repair.
 */
function shownQuoteKind(text: SceneText, sources: SourceSets): SacredQuoteKind | null {
  for (const field of shownFields(text)) {
    const first = shownSpans(field, sources.hadith).spans[0];
    if (first) return first.kind;
  }
  return null;
}

const MESSAGES: Readonly<Record<string, string>> = {
  [SACRED_TEXT_ALTERED]:
    'a Quran verse or hadith differs from the book text (changed, invented, copied without its brackets or quote, or cut without «…»)',
  [SACRED_TEXT_SPLIT]: 'a Quran verse is cut or split across slides (a ﴿ or ﴾ has no pair)',
  [SACRED_TEXT_EXPLAINED]:
    'a Quran verse or hadith is explained (meaning, tafsir); only the book grammar or style point may follow it',
  [SACRED_TEXT_IN_QUIZ_OPTION]:
    'a quiz option holds a Quran verse or hadith that is not the exact quote of its stem',
  [SACRED_TEXT_COMPLETION_ITEM]: 'a "complete the verse / hadith" item, or a quote with a blank',
  [SACRED_TEXT_NARRATED]:
    'narration or a character speaks a Quran verse or hadith; it must say «تأمّل الآية المعروضة» / «تأمّل الحديث المعروض» instead',
  [SACRED_TEXT_WITH_AUDIO]: 'a slide that shows a Quran verse or hadith carries audio or video',
  [SACRED_TEXT_IN_EXERCISE]:
    'an exercise or check slide shows a Quran verse or hadith item; verse and hadith items are removed from exercises and checks',
};

/**
 * Every finding of the generated Scenes, one per (Scene, code). `quotes` are
 * the run's source quotes; with none, any ﴿…﴾ span or attributed hadith in
 * the package is an invented quote.
 */
export function validateSacredText(
  scenes: readonly SacredSceneLike[],
  quotes: readonly SacredQuote[],
  scope?: SacredExerciseScope,
): SacredTextFinding[] {
  const sources = sourceSets(quotes);
  const shownRuns = quoteRuns(quotes, false);
  const spokenRuns = quoteRuns(quotes, true);
  const findings: SacredTextFinding[] = [];
  for (const scene of scenes) {
    const text = sceneText(scene);
    const codes = new Set<string>();
    // L-1: decided for the whole Scene first; then any shown field (title,
    // assistance, whiteboard, quiz explanation) or speech that explains fails.
    const showsQuote = shownQuoteKind(text, sources) !== null;
    for (const field of [...text.display, ...text.practice]) {
      const result = checkShownText(field, sources, shownRuns);
      for (const code of result.codes) codes.add(code);
    }
    for (const item of text.quiz) {
      const stem = checkShownText(item.stem, sources, shownRuns);
      for (const code of stem.codes) codes.add(code);
      const stemSpans = new Set(stem.spans);
      for (const option of item.options) {
        const result = checkShownText(option, sources, shownRuns);
        for (const code of result.codes) {
          if (code !== SACRED_TEXT_SPLIT) codes.add(code);
        }
        // Q-12: a verse is never a distractor; only the stem's own quote may recur.
        if (result.spans.some((span) => !stemSpans.has(span))) {
          codes.add(SACRED_TEXT_IN_QUIZ_OPTION);
        }
        if (
          result.spans.length === 0 &&
          runIn(option, spokenRuns) &&
          !runIn(item.stem, spokenRuns)
        ) {
          codes.add(SACRED_TEXT_IN_QUIZ_OPTION);
        }
      }
      for (const other of item.other) {
        const result = checkShownText(other, sources, shownRuns);
        for (const code of result.codes) codes.add(code);
      }
    }
    if (showsQuote && shownFields(text).some(explainedAnywhere)) {
      codes.add(SACRED_TEXT_EXPLAINED);
    }
    for (const spoken of text.spoken) {
      if (spokenQuoteKind(spoken, spokenRuns)) codes.add(SACRED_TEXT_NARRATED);
      if (showsQuote && explainedAnywhere(spoken)) codes.add(SACRED_TEXT_EXPLAINED);
    }
    if (showsQuote && text.hasAudio) codes.add(SACRED_TEXT_WITH_AUDIO);
    // 4 Nov 2026: a verse or hadith is never an exercise or check item; the
    // strip step ({@link stripSacredExerciseItems}) removes the item.
    if (showsQuote && isSacredExerciseScene(scene, scope)) codes.add(SACRED_TEXT_IN_EXERCISE);
    for (const code of codes) {
      findings.push({ code, sceneId: scene.id, message: MESSAGES[code] ?? code });
    }
  }
  return findings;
}

/** One generated question's learner-visible texts (H-2). */
export interface SacredQuestionText {
  stem: string;
  options: readonly string[];
  /** Explanation, model answer, rubric, per-choice rationales. */
  other: readonly string[];
}

/**
 * H-2: the quiz half of {@link validateSacredText} over generated questions
 * (bank questions, book-question enrichment): each question is checked as its
 * own quiz Scene. Returns the distinct finding codes, never any text.
 */
export function sacredQuestionFindings(
  questions: readonly SacredQuestionText[],
  quotes: readonly SacredQuote[],
): string[] {
  const scenes: SacredSceneLike[] = questions.map((question, index) => ({
    id: `question-${index + 1}`,
    type: 'quiz',
    content: {
      questions: [
        { question: question.stem, options: [...question.options], analysis: [...question.other] },
      ],
    },
  }));
  return [...new Set(validateSacredText(scenes, quotes).map((finding) => finding.code))];
}

/**
 * N-M1 (book-question enrichment): the findings of the texts a model ADDED to
 * a read-only book question, each checked as its own shown field. Whether the
 * item shows a quote (so an explanation fails) comes from the book's own
 * texts too; their own findings are never reported.
 */
export function sacredAddedTextFindings(
  bookTexts: readonly string[],
  added: readonly string[],
  quotes: readonly SacredQuote[],
): string[] {
  const sources = sourceSets(quotes);
  const runs = quoteRuns(quotes, false);
  const codes = new Set<string>();
  let showsQuote = bookTexts.some((text) => shownSpans(text, sources.hadith).spans.length > 0);
  for (const field of added) {
    const result = checkShownText(field, sources, runs);
    for (const code of result.codes) codes.add(code);
    if (result.spans.length > 0) showsQuote = true;
  }
  if (showsQuote && added.some(explainedAnywhere)) codes.add(SACRED_TEXT_EXPLAINED);
  return [...codes];
}

/** A blank line: newline, optional non-newline whitespace, newline (captured). */
const PARAGRAPH_BREAK = new RegExp(`(\\n${WS_NOT_NEWLINE}*\\n)`, 'u');

/**
 * The detection chunks of a joined text (N-M2, M-1): its paragraphs, except
 * that a paragraph whose verse brackets do not pair is merged with the
 * following paragraphs until they do (a verse split by a blank line). When no
 * merge pairs them, the paragraph stands alone (a stray bracket). Hadith quote
 * pairs are not merged: the shared rule never lets a hadith span a blank line.
 */
const MAX_PARAGRAPH_JOINS = 2;

function detectionChunks(text: string): string[] {
  const parts = text.split(PARAGRAPH_BREAK);
  const paragraphs = parts.filter((_, index) => index % 2 === 0);
  const breaks = parts.filter((_, index) => index % 2 === 1);
  const paired = (chunk: string) => !findVerseSpans(chunk).unbalanced;
  const chunks: string[] = [];
  let index = 0;
  while (index < paragraphs.length) {
    let chunk = paragraphs[index]!;
    let end = index;
    // MEDIUM-1: at most MAX_PARAGRAPH_JOINS blank-line joins, and only across
    // bracket-free paragraphs up to the FIRST one with a bracket, so two stray
    // brackets far apart (or a stray before a whole verse) never pair.
    while (
      !paired(chunk) &&
      end + 1 < paragraphs.length &&
      end - index < MAX_PARAGRAPH_JOINS &&
      (end === index || !ORNATE_ANY.test(paragraphs[end]!))
    ) {
      end += 1;
      chunk += breaks[end - 1]! + paragraphs[end]!;
    }
    if (paired(chunk)) {
      chunks.push(chunk);
      index = end + 1;
    } else {
      chunks.push(paragraphs[index]!);
      index += 1;
    }
  }
  return chunks;
}

/**
 * N-M2: the quotes of a long joined text (a retained lesson source), detected
 * per paragraph like {@link sacredQuotesFromManifest} detects per unit, so one
 * stray ﴿ or ﴾ voids only the verses of its own paragraph (M-1: a verse split
 * by a blank line is still one quote).
 */
export function detectSacredQuotesByParagraph(text: string): SacredQuote[] {
  const quotes: SacredQuote[] = [];
  const seen = new Set<string>();
  for (const paragraph of detectionChunks(text)) {
    for (const quote of detectSacredQuotes({ id: '', normalizedText: paragraph })) {
      const key = `${quote.kind}\u0000${quote.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      quotes.push(quote);
    }
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// Narration (Q-7, S-4) and characters (Q-11)
// ---------------------------------------------------------------------------

/** Collapse the owner's line when it now repeats with only punctuation between. */
function collapseLines(text: string): string {
  let out = text;
  for (const line of Object.values(SACRED_NARRATION_LINE)) {
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?:[\\s،,.:؛]*${escaped})+`, 'gu'), line);
  }
  return out.replace(/[ \t]{2,}/g, ' ');
}

// ---------------------------------------------------------------------------
// Exercises and checks (owner decision, 4 Nov 2026)
// ---------------------------------------------------------------------------

/**
 * Owner decision (4 Nov 2026): a Quran verse or hadith is never an exercise or
 * check item. Exercise and check slides drop every item that holds one, shown
 * and spoken; only the other items (a poetry line, a sentence) are kept and
 * solved. Explanation slides that show a verse as the book's example are not
 * touched.
 */
export interface SacredExerciseScope {
  /**
   * Scenes that solve an exercise or check unit of the book (g5.v8: an outline
   * citing an element=exercise or try_it unit), beside the Scenes whose
   * `contentRole` or teaching stage already marks them.
   */
  exerciseSceneIds?: ReadonlySet<string>;
}

const EXERCISE_ROLES: ReadonlySet<string> = new Set(['practice', 'check_understanding']);
const EXERCISE_STAGE = /exercise|practice/i;

/** Whether a Scene is an exercise or check slide (contentRole, stage, or scope). */
export function isSacredExerciseScene(
  scene: SacredSceneLike,
  scope: SacredExerciseScope | undefined,
): boolean {
  // The rule rides the g5.v8 path only: without a scope nothing is an exercise.
  if (!scope) return false;
  if (scope.exerciseSceneIds?.has(scene.id)) return true;
  const content = (scene.content ?? {}) as Record<string, unknown>;
  if (typeof content.contentRole === 'string' && EXERCISE_ROLES.has(content.contentRole)) {
    return true;
  }
  const stage = (scene as { teachingStage?: { key?: unknown } }).teachingStage?.key;
  return typeof stage === 'string' && EXERCISE_STAGE.test(stage);
}

/** The ids of the Scenes whose outline cites one of `unitIds` (exercise / check units). */
export function exerciseSceneIdsOf(
  scenes: ReadonlyArray<{ id: string; outlineId?: string }>,
  outlines: ReadonlyArray<{ id: string; sourceContentUnitIds?: readonly unknown[] }>,
  unitIds: ReadonlySet<string>,
): Set<string> {
  if (unitIds.size === 0) return new Set();
  const citing = new Set(
    outlines
      .filter((outline) =>
        (outline.sourceContentUnitIds ?? []).some((id) => unitIds.has(String(id))),
      )
      .map((outline) => outline.id),
  );
  return new Set(
    scenes.filter((scene) => scene.outlineId && citing.has(scene.outlineId)).map((s) => s.id),
  );
}

/**
 * H-2: the exercise scope of ONE regenerated or inserted Scene of a g5.v8
 * package: the Scene is an exercise or check Scene when it cites one of the
 * book's exercise or «تأكد» check units (`exerciseUnitIds`), beside its role
 * and stage. `undefined` (no book map) keeps the rule off, as in the run.
 */
export function singleSceneExerciseScope(
  candidate: { id: string },
  citedUnitIds: readonly unknown[],
  exerciseUnitIds: readonly string[] | undefined,
): SacredExerciseScope | undefined {
  if (!exerciseUnitIds) return undefined;
  const units = new Set(exerciseUnitIds.map(String));
  return {
    exerciseSceneIds: new Set(
      citedUnitIds.some((id) => units.has(String(id))) ? [candidate.id] : [],
    ),
  };
}

/**
 * The text without the lines that hold a verse or hadith span (a span over two
 * lines drops both). A book exercise lists one item per line, so the others
 * stay exactly as printed.
 */
export function withoutSacredItems(text: string): string {
  const { spans } = findSacredSpans(text);
  if (spans.length === 0) return text;
  const kept: string[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (!spans.some((span) => span.start < end && start < span.end)) kept.push(line);
  }
  return kept.join('\n');
}

/** Block-level HTML pieces: each <p>, <li>, <div> or <h*> is one item. */
const HTML_BLOCK = /<(p|li|div|h[1-6])\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** {@link withoutSacredItems} for one shown string, HTML or plain. */
function withoutSacredItemsShown(value: string): string {
  if (findSacredSpans(htmlToText(value)).spans.length === 0) return value;
  if (/<(?:p|li|div|h[1-6])\b/i.test(value)) {
    const out = value.replace(HTML_BLOCK, (block) =>
      findSacredSpans(htmlToText(block)).spans.length > 0 ? '' : block,
    );
    if (findSacredSpans(htmlToText(out)).spans.length === 0) return out;
    return withoutSacredItems(out.replace(/<\s*br\s*\/?>/gi, '\n'));
  }
  return withoutSacredItems(value.replace(/<\s*br\s*\/?>/gi, '\n'));
}

function stripShownItems(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key && NON_TEXT_KEYS.has(key) ? value : withoutSacredItemsShown(value);
  }
  if (Array.isArray(value)) return value.map((item) => stripShownItems(item, key));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [childKey, child] of Object.entries(record)) {
      record[childKey] = stripShownItems(child, childKey);
    }
  }
  return value;
}

/**
 * The strip step of the exercise rule: on every exercise or check Scene,
 * removes each shown item (line, paragraph, list item) that holds a verse or
 * hadith, and each spoken sentence that reads one. Mutates the Scenes; runs
 * before {@link stripSacredNarration} and TTS. Returns the Scenes changed.
 */
export function stripSacredExerciseItems(
  scenes: readonly SacredSceneLike[],
  quotes: readonly SacredQuote[],
  scope: SacredExerciseScope,
): number {
  const runs = quoteRuns(quotes, true);
  let changed = 0;
  for (const scene of scenes) {
    if (!isSacredExerciseScene(scene, scope)) continue;
    const before = JSON.stringify([scene.title, scene.content, scene.actions]);
    if (typeof scene.title === 'string') scene.title = withoutSacredItemsShown(scene.title);
    if (scene.content && typeof scene.content === 'object') stripShownItems(scene.content);
    // L-6: a speech emptied by the strip is dropped; when it was the Scene's
    // only narration, the owner's line is kept in its place.
    const emptied = new Map<Record<string, unknown>, SacredQuoteKind>();
    for (const action of actionsOf(scene)) {
      if (action.type === 'speech' && typeof action.text === 'string') {
        const text = action.text;
        let removed: SacredQuoteKind | null = null;
        action.text = sentenceRanges(text)
          .map((range) => text.slice(range.start, range.end))
          .filter((sentence) => {
            const kind =
              findSacredSpans(sentence).spans[0]?.kind ?? spokenQuoteKind(sentence, runs);
            if (kind) removed ??= kind;
            return !kind;
          })
          .join('')
          .trim();
        if (action.text === '' && text.trim() !== '') emptied.set(action, removed ?? 'quran');
      } else if (
        isWhiteboardContent(action.type) ||
        WIDGET_TEXT_ACTIONS.has(action.type as string)
      ) {
        stripShownItems(action);
      }
    }
    if (emptied.size > 0 && Array.isArray(scene.actions)) {
      const spoken = actionsOf(scene).some(
        (action) => action.type === 'speech' && !emptied.has(action),
      );
      const [keep, kind] = spoken ? [undefined, undefined] : [...emptied][0]!;
      // F-5: the owner's line only while the Scene still shows a quote of that
      // kind; once the strip removed it from display, a neutral line.
      const stillShown = kind ? shownQuoteKind(sceneText(scene), sourceSets(quotes)) : null;
      if (keep && kind) {
        const tryIt =
          ((scene.content ?? {}) as Record<string, unknown>).contentRole === 'check_understanding';
        keep.text = stillShown
          ? SACRED_NARRATION_LINE[stillShown]
          : tryIt
            ? TRY_IT_NEUTRAL_LINE
            : EXERCISE_NEUTRAL_LINE;
      }
      scene.actions = (scene.actions as unknown[]).filter(
        (action) => action === keep || !emptied.has(action as Record<string, unknown>),
      ) as typeof scene.actions;
    }
    if (JSON.stringify([scene.title, scene.content, scene.actions]) !== before) changed += 1;
  }
  return changed;
}

/** The sentences of a spoken text: each ends after «.», «!», «؟», «?» or a newline. */
function sentenceRanges(text: string): Array<{ start: number; end: number; body: number }> {
  const ranges: Array<{ start: number; end: number; body: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/[.!؟?\n]/.test(text[index]!)) {
      ranges.push({ start, end: index + 1, body: index });
      start = index + 1;
    }
  }
  if (start < text.length) ranges.push({ start, end: text.length, body: text.length });
  return ranges;
}

function speechWithRuns(text: string, runs: QuoteRuns, shownKind: SacredQuoteKind | null): string {
  const found = findSacredSpans(text);
  const brackets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (ORNATE.has(text[index]!)) brackets.push(index);
  }
  let out = '';
  // LOW-1: an introduction with nothing after it («قال تعالى:» then a new line)
  // carries over: the next sentence with letters is the quote, replaced too.
  let carried: SacredQuoteKind | null = null;
  let awaitingLine = false;
  for (const range of sentenceRanges(text)) {
    const sentence = text.slice(range.start, range.body);
    const overlapping = found.spans.filter(
      (span) => span.start < range.body && range.start < span.end,
    );
    const reads: SacredQuoteKind | null = overlapping.some((span) => span.kind === 'hadith')
      ? 'hadith'
      : overlapping.length > 0 ||
          brackets.some((index) => index >= range.start && index < range.end)
        ? 'quran'
        : spokenQuoteKind(sentence, runs);
    // M-2: on a Scene that shows a quote, a sentence that explains it is
    // replaced too, before TTS (the check would pause the run after it).
    const hasLetters = /\p{L}/u.test(sentence);
    const kind =
      reads ??
      (hasLetters ? carried : null) ??
      (shownKind && explainedAnywhere(sentence) ? shownKind : null);
    // M-1: an introduction carries to the end of its line block — or, when
    // nothing follows it on its own line («قال تعالى:» then a new line), to
    // the end of the next line with letters — so a verse of several
    // sentences is replaced whole.
    // A bracketed verse or attributed hadith in the intro's sentence marks the
    // quote's own extent: nothing carries.
    // H-1: a sentence whose last verse bracket OPENS a pair (sequential
    // pairing: an even position) starts a verse that runs on: carry 'quran'
    // until the sentence that closes it, or the end of the line block.
    const inSentence = brackets
      .map((position, order) => ({ position, order }))
      .filter(({ position }) => position >= range.start && position < range.end);
    const lastBracket = inSentence[inSentence.length - 1];
    const opensVerse = lastBracket !== undefined && lastBracket.order % 2 === 0;
    const delimited = !opensVerse && (overlapping.length > 0 || inSentence.length > 0);
    if (opensVerse) {
      carried = 'quran';
      awaitingLine = !/\p{L}/u.test(text.slice(lastBracket.position + 1, range.body));
    } else if (lastBracket !== undefined && carried === 'quran') {
      // This sentence closes the verse: nothing after it carries.
      carried = null;
    } else if (hasLetters) {
      const intro = delimited ? null : spokenIntro(sentence);
      if (intro) {
        carried = intro.kind;
        awaitingLine = !intro.trailing;
      } else if (carried) {
        awaitingLine = false;
      }
    }
    if (carried && !awaitingLine && text[range.body] === '\n') carried = null;
    if (kind) {
      const lead = /^\s*/.exec(sentence)![0];
      out += `${lead}${SACRED_NARRATION_LINE[kind]}${text.slice(range.body, range.end)}`;
    } else {
      out += text.slice(range.start, range.end);
    }
  }
  out = collapseLines(out);
  // The check reads the whole line; a run across two sentences still reads it.
  const left =
    spokenQuoteKind(out, runs) ?? (shownKind && explainedAnywhere(out) ? shownKind : null);
  return left ? SACRED_NARRATION_LINE[left] : out;
}

/**
 * One spoken line with every sentence that reads a quote replaced by the
 * owner's line (S-4), by the same predicate {@link validateSacredText} uses.
 * `shownKind` (M-2): the kind of the quote the Scene shows, when it shows one;
 * a sentence that explains it («معنى الآية», «سبب النزول») is replaced too.
 */
export function stripSacredSpeech(
  text: string,
  quotes: readonly SacredQuote[],
  shownKind: SacredQuoteKind | null = null,
): string {
  const runs = quoteRuns(quotes, true);
  if (!spokenQuoteKind(text, runs) && !(shownKind && explainedAnywhere(text))) return text;
  return speechWithRuns(text, runs, shownKind);
}

/**
 * Q-7 / Q-11: every speech line and discussion prompt of the Scenes, with each
 * quote replaced by the owner's line. Runs BEFORE TTS, so no audio of a quote
 * is ever made. Mutates the actions; returns how many lines changed.
 */
export function stripSacredNarration(
  scenes: readonly SacredSceneLike[],
  quotes: readonly SacredQuote[],
): number {
  let changed = 0;
  const sources = sourceSets(quotes);
  for (const scene of scenes) {
    const shownKind = shownQuoteKind(sceneText(scene), sources);
    for (const action of actionsOf(scene)) {
      const keys =
        action.type === 'speech'
          ? (['text'] as const)
          : action.type === 'discussion'
            ? (['topic', 'prompt'] as const)
            : [];
      for (const key of keys) {
        const value = action[key];
        if (typeof value !== 'string') continue;
        const stripped = stripSacredSpeech(value, quotes, shownKind);
        if (stripped !== value) {
          action[key] = stripped;
          changed += 1;
        }
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Image prompts (Q-11)
// ---------------------------------------------------------------------------

/**
 * S-9: scripture words with Arabic word boundaries (no letter or mark on
 * either side), an optional proclitic (و ف ب ل ك ال), so «الحديث» matches
 * and «الحديثة» does not.
 */
const SCRIPTURE_WORDS =
  /(?<![\p{L}\p{M}])(?:(?:و|ف|ب|ل|ك)?(?:ال|ل)?(?:قرآن|آية|آيات|سورة|حديث|أحاديث|مصحف)|quran|koran|qur'an|verse|ayah|hadith|scripture|surah)(?![\p{L}\p{M}])/iu;

export const SACRED_IMAGE_DIRECTIVE =
  'Do not draw any text, letters, calligraphy, Quran verse, hadith or other scripture in the image, and do not illustrate the meaning of a verse or hadith.';

function removeAll(text: string, needle: string): string {
  if (needle.length < 8 || !text.includes(needle)) return text;
  return text.split(needle).join('');
}

/** One image prompt without any quote text, plus the no-scripture directive when needed. */
export function stripSacredTextFromImagePrompt(
  prompt: string,
  quotes: readonly SacredQuote[],
): string {
  let out = prompt;
  for (const span of [...findSacredSpans(out).spans].reverse()) {
    out = `${out.slice(0, span.start)}${out.slice(span.end)}`;
  }
  out = out.replace(/[﴾﴿]/g, '');
  for (const quote of quotes) out = removeAll(out, quoteInner(quote.kind, quote.text));
  const changed = out !== prompt;
  out = out.replace(/[ \t]{2,}/g, ' ').trim();
  if ((changed || SCRIPTURE_WORDS.test(out)) && !out.includes(SACRED_IMAGE_DIRECTIVE)) {
    out = `${out}${out ? ' ' : ''}${SACRED_IMAGE_DIRECTIVE}`;
  }
  return changed || out !== prompt.trim() ? out : prompt;
}

/** Every outline's generation requests, stripped in place; returns how many changed. */
export function stripSacredTextFromMediaRequests(
  outlines: ReadonlyArray<{ mediaGenerations?: Array<{ prompt?: unknown }> }>,
  quotes: readonly SacredQuote[],
): number {
  let changed = 0;
  for (const outline of outlines) {
    for (const request of outline.mediaGenerations ?? []) {
      if (typeof request.prompt !== 'string') continue;
      const stripped = stripSacredTextFromImagePrompt(request.prompt, quotes);
      if (stripped !== request.prompt) {
        request.prompt = stripped;
        changed += 1;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Integrity (Q-14, S-5)
// ---------------------------------------------------------------------------

function shownTexts(scene: SacredSceneLike): string[] {
  return shownFields(sceneText(scene));
}

/**
 * The pins of every source quote of the run (Q-14), each marked `used` when the
 * package shows it exactly. Every book quote is pinned, not only the shown ones,
 * so a later regeneration or edit may show another book quote exactly — and
 * never a changed one. A faithful «…» cut the package shows is pinned too (its
 * own canonical text), so an unchanged cut survives an editor save; so is a
 * copy that differs from its source only in whitespace (M-4: pins stay on the
 * raw text, so the shown variant gets its own raw hash).
 */
export function usedSacredQuotePins(
  scenes: readonly SacredSceneLike[],
  quotes: readonly SacredQuote[],
): SacredQuotePin[] {
  const sources = sourceSets(quotes);
  const shown: SacredSpan[] = [];
  for (const scene of scenes) {
    for (const field of shownTexts(scene)) shown.push(...shownSpans(field, sources.hadith).spans);
  }
  const shownTextsByKind = new Set(
    shown.map((span) => `${span.kind}\u0000${collapseWhitespace(span.canonical)}`),
  );
  const pins: SacredQuotePin[] = [];
  const seen = new Set<string>();
  const pin = (quote: SacredQuote, sha256: string, used: boolean) => {
    if (seen.has(sha256)) return;
    seen.add(sha256);
    pins.push({
      used,
      kind: quote.kind,
      sha256,
      sourceBlockId: quote.sourceBlockId,
      contentUnitId: quote.contentUnitId,
      reference: quote.reference,
    });
  };
  for (const quote of quotes) {
    pin(
      quote,
      quote.sha256,
      shownTextsByKind.has(`${quote.kind}\u0000${collapseWhitespace(quote.text)}`),
    );
  }
  for (const span of shown) {
    const sha256 = sha256Hex(span.canonical);
    if (seen.has(sha256)) continue;
    const source = quotes.find(
      (quote) => quote.kind === span.kind && spanMatches(span, quote.text),
    );
    if (source) pin(source, sha256, true);
  }
  return pins;
}

/** A pin list read back from storage, or `null` when the record has none. */
export function readSacredQuotePins(value: unknown): SacredQuotePin[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const record = entry as Partial<SacredQuotePin> | null;
    return record && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)
      ? [
          {
            used: record.used === true,
            kind: record.kind === 'hadith' ? ('hadith' as const) : ('quran' as const),
            sha256: record.sha256,
            sourceBlockId: record.sourceBlockId ?? null,
            contentUnitId: String(record.contentUnitId ?? ''),
            reference: record.reference ?? null,
          },
        ]
      : [];
  });
}

/**
 * Q-14: an editor write is refused when a Scene it carries shows a quote span
 * that is not pinned (changed or added), cuts a verse, or speaks one (a
 * bracket, an attributed hadith, or a word run of the Scene's pinned quotes,
 * S-5). Pins are the package's own; a write needs no diff against the stored
 * Scene.
 *
 * `recovered` (M-1, M-3): the pinned quote texts recovered from the STORED
 * Scenes (or, on one-scene regeneration / insertion, those recovered for the
 * prompt). With them, a span that is not itself pinned still passes when it
 * equals one of them modulo whitespace or cuts it faithfully with «…», and a
 * copy of five words in a row OUTSIDE any span (brackets or attribution
 * removed) or in speech is refused — so removing the brackets no longer
 * disables the check.
 */
export function findPinnedSacredTextEdits(
  scenes: readonly SacredSceneLike[],
  pins: readonly SacredQuotePin[],
  recovered: readonly SacredQuote[] = [],
): SacredTextFinding[] {
  const pinned = new Set(pins.map((pin) => pin.sha256));
  const findings: SacredTextFinding[] = [];
  for (const scene of scenes) {
    const codes = new Set<string>();
    const shown = shownTexts(scene);
    const known = mergeQuotes(recovered, pinnedQuotesIn(shown, pins));
    const sources = sourceSets(known);
    const shownRuns = quoteRuns(known, false);
    for (const field of shown) {
      const found = shownSpans(field, sources.hadith);
      if (found.unbalanced) codes.add(SACRED_TEXT_SPLIT);
      for (const span of found.spans) {
        if (!pinned.has(sha256Hex(span.canonical)) && !matchesSource(span, sources[span.kind])) {
          codes.add(SACRED_TEXT_PINNED);
        }
      }
      if (runIn(outsideSpans(field, found.spans), shownRuns)) codes.add(SACRED_TEXT_ALTERED);
    }
    const runs = quoteRuns(known, true);
    for (const spoken of sceneText(scene).spoken) {
      if (spokenQuoteKind(spoken, runs)) codes.add(SACRED_TEXT_NARRATED);
    }
    for (const code of codes) {
      findings.push({
        code,
        sceneId: scene.id,
        message:
          code === SACRED_TEXT_PINNED
            ? 'this edit changes a Quran verse or hadith the package pins to the book text; verses and hadith are never edited'
            : (MESSAGES[code] ?? code),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// One-scene regeneration and insertion (after the package exists)
// ---------------------------------------------------------------------------

/**
 * The exact book quotes recoverable without the source: the verses and
 * attributed hadith of the given texts whose canonical sha256 is pinned. They
 * carry no unit, so a scene prompt lists them all.
 */
export function pinnedQuotesIn(
  texts: readonly string[],
  pins: readonly SacredQuotePin[],
): SacredQuote[] {
  const byHash = new Map(pins.map((pin) => [pin.sha256, pin] as const));
  const quotes: SacredQuote[] = [];
  const seen = new Set<string>();
  const hadithPinned = (canonical: string) => byHash.get(sha256Hex(canonical))?.kind === 'hadith';
  for (const text of texts) {
    const found = findSacredSpans(text).spans;
    // M-6: a pinned hadith shown in its quote marks without the attribution.
    const unattributed = quotePairSpans(text, found, hadithPinned);
    for (const span of [...found, ...unattributed]) {
      const sha256 = sha256Hex(span.canonical);
      const pin = byHash.get(sha256);
      if (!pin || seen.has(sha256)) continue;
      seen.add(sha256);
      quotes.push({
        kind: span.kind,
        text: span.canonical,
        reference: pin.reference,
        sourceBlockId: pin.sourceBlockId,
        sha256,
        canonicalStatus: 'unchecked',
        contentUnitId: '',
        origin: 'detected',
      });
    }
  }
  return quotes;
}

/**
 * Every verse and attributed hadith the texts show, as quotes with their own
 * canonical text and sha256 (no pin needed). For STORED Scenes only: stored
 * content already passed generation, one-scene regeneration / insertion or the
 * edit guard, so a cut or line-wrapped verse written there without a new pin
 * survives an unchanged save, and its words still feed the copy and speech checks.
 */
export function shownQuotesIn(texts: readonly string[]): SacredQuote[] {
  const quotes: SacredQuote[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const span of findSacredSpans(text).spans) {
      const sha256 = sha256Hex(span.canonical);
      if (seen.has(sha256)) continue;
      seen.add(sha256);
      quotes.push({
        kind: span.kind,
        text: span.canonical,
        reference: null,
        sourceBlockId: null,
        sha256,
        canonicalStatus: 'unchecked',
        contentUnitId: '',
        origin: 'detected',
      });
    }
  }
  return quotes;
}

/** Two quote lists as one, each quote once (by kind and sha256). */
function mergeQuotes(a: readonly SacredQuote[], b: readonly SacredQuote[]): SacredQuote[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((quote) => {
    const key = `${quote.kind}\u0000${quote.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every learner-visible text of the Scenes (for {@link pinnedQuotesIn}). */
export function shownSceneTexts(scenes: readonly SacredSceneLike[]): string[] {
  return scenes.flatMap(shownTexts);
}

/**
 * S-5: the quotes of one regenerated or inserted Scene's checks: those
 * recovered for its prompt plus the candidate's OWN shown quotes that hash to
 * a pin, so its narration repair and run checks know every quote it shows.
 */
export function withCandidateQuotes(
  candidate: SacredSceneLike,
  pins: readonly SacredQuotePin[],
  quotes: readonly SacredQuote[],
): SacredQuote[] {
  const seen = new Set(quotes.map((quote) => quote.sha256));
  const own = pinnedQuotesIn(shownTexts(candidate), pins).filter(
    (quote) => !seen.has(quote.sha256),
  );
  return [...quotes, ...own];
}

/**
 * The checks of ONE regenerated or inserted Scene of a pinned package, after
 * its narration was stripped: quote spans must hash to a pin (Q-14), and every
 * other rule (altered copies, split, explained, distractor, completion,
 * spoken, audio) applies against the quotes recovered for it.
 */
export function singleSceneSacredFindings(
  candidate: SacredSceneLike,
  pins: readonly SacredQuotePin[],
  quotes: readonly SacredQuote[],
  scope?: SacredExerciseScope,
): SacredTextFinding[] {
  const all = withCandidateQuotes(candidate, pins, quotes);
  // M-3: a new faithful cut of a recovered quote passes, as the policy allows.
  const pinned = findPinnedSacredTextEdits([candidate], pins, all);
  // H-2: the exercise rule (4 Nov 2026) holds on one regenerated or inserted Scene.
  const rules = validateSacredText([candidate], all, scope);
  const seen = new Set<string>();
  return [...pinned, ...rules].filter((finding) => {
    if (seen.has(finding.code)) return false;
    seen.add(finding.code);
    return true;
  });
}

/** Has the pin list been changed (an edit may never rewrite the pins themselves)? */
export function samePins(a: readonly SacredQuotePin[], b: readonly SacredQuotePin[]): boolean {
  const key = (pins: readonly SacredQuotePin[]) =>
    pins
      .map((pin) => `${pin.kind}:${pin.sha256}:${pin.sourceBlockId ?? ''}:${pin.contentUnitId}`)
      .sort()
      .join('|');
  return key(a) === key(b);
}

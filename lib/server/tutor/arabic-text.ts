/**
 * Bilingual (Arabic / English) text normalisation for the rule-based context
 * assessment, the title fallback and the safety guard (Kafuo R1 plan §8.2,
 * Revision 1 `arabic-text.ts`).
 *
 * Pure string functions, no model, no I/O. Normalisation is deliberately
 * lossy: it exists so that "الدَّرْس", "الدرس" and "درس" compare equal, not to
 * preserve text. Callers keep the original for the model and use these
 * forms only for matching.
 */

// U+064B..U+0652 harakat, U+0670 superscript alef, U+0640 tatweel,
// U+0653..U+0655 (madda / hamza above / below), U+0656..U+065F extended marks.
const TASHKEEL_AND_TATWEEL = /[\u0640\u064B-\u065F\u0670]/g;

/** Strip tashkeel/tatweel and unify alef, taa marbuta and yaa forms. */
export function normalizeArabic(text: string): string {
  return text
    .replace(TASHKEEL_AND_TATWEEL, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // آ أ إ ٱ → ا
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/[\u0649\u06CC]/g, '\u064A') // ى / Persian yeh → ي
    .replace(/\u0624/g, '\u0648') // ؤ → و
    .replace(/\u0626/g, '\u064A'); // ئ → ي
}

/** Lower-case Latin, normalise Arabic, collapse whitespace. */
export function normalizeText(text: string): string {
  return normalizeArabic(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

const ARABIC_STOPWORD_LIST = [
  'في', 'من', 'على', 'الى', 'إلى', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك', 'هو', 'هي', 'هم',
  'انا', 'أنا', 'انت', 'أنت', 'نحن', 'ما', 'ماذا', 'لماذا', 'ليه', 'كيف', 'ازاي', 'متى', 'اين',
  'أين', 'هل', 'لا', 'نعم', 'او', 'أو', 'و', 'ثم', 'لكن', 'بل', 'ان', 'أن', 'إن', 'كان', 'كانت',
  'يكون', 'تكون', 'قد', 'لقد', 'كل', 'بعض', 'غير', 'بين', 'حتى', 'اذا', 'إذا', 'لو', 'عند',
  'عندما', 'لدي', 'لي', 'له', 'لها', 'لهم', 'به', 'بها', 'فيه', 'فيها', 'منه', 'منها', 'عليه',
  'عليها', 'ايضا', 'أيضا', 'جدا', 'فقط', 'الي', 'ال', 'يا', 'ده', 'دي', 'دا', 'كده', 'ايه',
  'إيه', 'مش', 'ممكن', 'عايز', 'عاوز', 'محتاج', 'ابغى', 'أبغى', 'اريد', 'أريد', 'من فضلك',
  'لو سمحت', 'شكرا', 'شكراً', 'طيب', 'تمام', 'اوك', 'ok', 'كمان', 'برضو', 'بس', 'يعني',
  'علي', 'حتي', 'متي', 'اللي', 'الذي', 'التي', 'الذين', 'هناك', 'هنا', 'كثير', 'قليل',
];

/** Stored in NORMALISED form so tokens (also normalised) compare equal. */
export const ARABIC_STOPWORDS: ReadonlySet<string> = new Set(
  ARABIC_STOPWORD_LIST.map((word) => normalizeArabic(word)),
);

export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'about', 'as', 'into', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will',
  'may', 'might', 'shall', 'i', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'them', 'their',
  'he', 'she', 'it', 'its', 'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'how', 'why', 'when', 'where', 'please', 'thanks', 'thank', 'ok', 'okay', 'yes', 'no', 'not',
  'just', 'also', 'very', 'more', 'some', 'any', 'all', 'there', 'here', 'again', 'now', 'than',
  'too', 'want', 'need', 'tell', 'give', 'know', 'like', 'get', 'got', 'one', 'thing', 'things',
]);

const ARABIC_LETTER = /[\u0600-\u06FF]/;
const LATIN_LETTER = /[A-Za-z]/;
/** Everything that is neither a letter (any script) nor a digit separates tokens. */
const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;

/** Normalised, lower-cased tokens (stopwords kept). */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(TOKEN_SEPARATOR)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isStopword(token: string): boolean {
  return ARABIC_STOPWORDS.has(token) || ENGLISH_STOPWORDS.has(token);
}

/** Arabic clitics that hide a content word: ال، و، ب، ل، ك، ف، س + definite article. */
function stripArabicClitics(token: string): string {
  let t = token;
  if (t.length > 4 && /^(و|ف|ب|ل|ك|س)ال/.test(t)) t = t.slice(1);
  if (t.length > 3 && t.startsWith('ال')) t = t.slice(2);
  else if (t.length > 3 && /^(و|ف)/.test(t) && !ARABIC_STOPWORDS.has(t.slice(1))) t = t.slice(1);
  return t;
}

/**
 * Content keywords: stopwords removed, Arabic clitics stripped, short tokens
 * dropped (Arabic ≥ 2 letters, Latin ≥ 3), duplicates removed in order.
 * Digits are kept (a "قانون 3" is content).
 */
export function extractKeywords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokenize(text)) {
    if (isStopword(raw)) continue;
    const token = ARABIC_LETTER.test(raw) ? stripArabicClitics(raw) : raw;
    if (isStopword(token)) continue;
    const minLength = ARABIC_LETTER.test(token) ? 2 : /^\d+$/.test(token) ? 1 : 3;
    if (token.length < minLength) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * The ORIGINAL surface words that count as content keywords, in order — for
 * student-visible text such as the fallback title, where a normalised form
 * ("استقرايي") must never be shown.
 */
export function contentSurfaceWords(text: string, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const surface = match[0];
    const [keyword] = extractKeywords(surface);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(surface);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The share of `query` keywords found in `reference` (0..1). Order-free; a
 * query without keywords overlaps nothing.
 */
export function keywordOverlap(query: readonly string[], reference: readonly string[]): number {
  if (query.length === 0) return 0;
  const reference_ = new Set(reference);
  let hits = 0;
  for (const keyword of query) if (reference_.has(keyword)) hits += 1;
  return hits / query.length;
}

export type Script = 'ar' | 'en' | 'mixed' | 'unknown';

/**
 * Script of the student's message for the response-language rule (BR-03):
 * the tutor replies in the language the student writes in. `mixed` when
 * neither script clearly dominates (≥ 70 % of letters), `unknown` for text
 * with no letters (digits, emoji).
 */
export function detectScript(text: string): Script {
  let arabic = 0;
  let latin = 0;
  for (const char of text) {
    if (ARABIC_LETTER.test(char)) arabic += 1;
    else if (LATIN_LETTER.test(char)) latin += 1;
  }
  const total = arabic + latin;
  if (total === 0) return 'unknown';
  if (arabic / total >= 0.7) return 'ar';
  if (latin / total >= 0.7) return 'en';
  return 'mixed';
}

/** Longest run of consecutive content keywords in the message (lesson-discovery cue). */
export function longestContentRun(text: string): number {
  let best = 0;
  let run = 0;
  for (const raw of tokenize(text)) {
    const token = ARABIC_LETTER.test(raw) ? stripArabicClitics(raw) : raw;
    const content = !isStopword(raw) && !isStopword(token) && token.length >= 2;
    run = content ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** A quoted phrase («…», "…", '…', “…”) of at least two words. */
export function hasQuotedPhrase(text: string): boolean {
  const match = text.match(/["“”«»']([^"“”«»']{3,120})["“”«»']/u);
  if (!match) return false;
  return match[1]!.trim().split(/\s+/).length >= 2;
}

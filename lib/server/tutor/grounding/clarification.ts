/**
 * Deterministic clarification turn (discovery-first plan P7, FRD §9, CHAT-05,
 * D-8 (a)): when the item resolution is uncertain the tutor asks which topic
 * the student means. No model call, no meter reservation.
 *
 * The text is a fixed bilingual template chosen by the student's script
 * (`detectScript`): Arabic for Arabic, English for English, both for mixed or
 * script-less text. It names at most three human-readable titles — never an
 * id (CHAT-04, RET-05).
 *
 * On the next turn a reply is matched against the pending candidates by
 * ordinal (1/2/3, ١/٢/٣, «الأول», «التاني»/«الثاني», «الثالث»/«التالت»,
 * first/second/third) or by title. Anything else is not a choice.
 */
import { detectScript, extractKeywords, normalizeText } from '@/lib/server/tutor/arabic-text';

export const CLARIFICATION_TEMPLATE_VERSION = 'clarify-v1';
export const MAX_CLARIFICATION_CANDIDATES = 3;
const TITLE_MAX_CHARS = 80;

/** One line, trimmed, bounded; `null` when nothing human-readable is left. */
export function clarificationTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : line;
}

function arabicText(titles: string[]): string {
  if (titles.length === 1) {
    return [
      `لست متأكدًا من الموضوع الذي تقصده. هل تقصد «${titles[0]}»؟`,
      'اكتب 1 للتأكيد، أو أعد صياغة سؤالك.',
    ].join('\n');
  }
  return [
    'سؤالك قد يخص أكثر من موضوع في المنهج. أي موضوع تقصد؟',
    ...titles.map((title, index) => `${index + 1}. ${title}`),
    'اكتب رقم الموضوع أو اسمه.',
  ].join('\n');
}

function englishText(titles: string[]): string {
  if (titles.length === 1) {
    return [
      `I'm not sure which topic you mean. Do you mean "${titles[0]}"?`,
      'Reply 1 to confirm, or rephrase your question.',
    ].join('\n');
  }
  return [
    'Your question could match more than one topic in the curriculum. Which one do you mean?',
    ...titles.map((title, index) => `${index + 1}. ${title}`),
    'Reply with the number or the topic name.',
  ].join('\n');
}

/** The clarification text for `question`, naming the (≤ 3, already cleaned) titles in order. */
export function clarificationText(question: string, titles: readonly string[]): string {
  const named = titles.slice(0, MAX_CLARIFICATION_CANDIDATES);
  const script = detectScript(question);
  if (script === 'en') return englishText(named);
  if (script === 'ar') return arabicText(named);
  return `${arabicText(named)}\n\n${englishText(named)}`;
}

// ---------------------------------------------------------------------------
// Follow-up matching
// ---------------------------------------------------------------------------

const DIGITS: Record<string, string> = {
  '١': '1',
  '٢': '2',
  '٣': '3',
  '۱': '1',
  '۲': '2',
  '۳': '3',
};

const ORDINALS: Record<string, number> = {
  '1': 0,
  '2': 1,
  '3': 2,
  الاول: 0,
  الثاني: 1,
  التاني: 1,
  الثالث: 2,
  التالت: 2,
  first: 0,
  second: 1,
  third: 2,
  '1st': 0,
  '2nd': 1,
  '3rd': 2,
};

const ORDINAL_PREFIXES = new Set([
  'رقم',
  'الرقم',
  'الموضوع',
  'موضوع',
  'الخيار',
  'خيار',
  'الاختيار',
  'اختيار',
  'اقصد',
  'قصدي',
  'number',
  'no',
  'option',
  'topic',
  'the',
]);

function cleanReply(text: string): string[] {
  const unified = normalizeText(text).replace(/[١٢٣۱۲۳]/g, (digit) => DIGITS[digit] ?? digit);
  return unified
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export interface ClarificationChoice {
  index: number;
  by: 'ordinal' | 'title';
}

/**
 * The candidate the reply chooses, or `null`. An ordinal must be the whole
 * reply (optionally after «رقم», «الموضوع», "option", …); a title matches
 * when the reply equals or contains it, or when every reply keyword belongs
 * to exactly one candidate's title.
 */
export function matchClarificationReply(
  text: string,
  titles: readonly string[],
): ClarificationChoice | null {
  const tokens = cleanReply(text);
  if (tokens.length === 0) return null;

  let start = 0;
  while (start < tokens.length - 1 && ORDINAL_PREFIXES.has(tokens[start]!)) start += 1;
  if (tokens.length - start === 1) {
    const ordinal = ORDINALS[tokens[start]!];
    if (ordinal !== undefined)
      return ordinal < titles.length ? { index: ordinal, by: 'ordinal' } : null;
  }

  const reply = tokens.join(' ');
  const normalizedTitles = titles.map((title) => cleanReply(title).join(' '));
  const contained = normalizedTitles
    .map((title, index) => ({ title, index }))
    .filter(({ title }) => title.length >= 3 && (reply === title || reply.includes(title)));
  if (contained.length === 1) return { index: contained[0]!.index, by: 'title' };
  if (contained.length > 1) return null;

  const replyKeywords = extractKeywords(text);
  if (replyKeywords.length === 0) return null;
  const covering = titles
    .map((title, index) => ({ keywords: new Set(extractKeywords(title)), index }))
    .filter(({ keywords }) => replyKeywords.every((keyword) => keywords.has(keyword)));
  return covering.length === 1 ? { index: covering[0]!.index, by: 'title' } : null;
}

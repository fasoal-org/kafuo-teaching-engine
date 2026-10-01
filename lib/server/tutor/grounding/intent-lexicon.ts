/**
 * Versioned tutoring-intent and follow-up lexicons for the `discovery_v1`
 * assessment ruleset (discovery-first plan P7 (a)/(b)/(c), CHAT-03).
 *
 * Intent words («اشرحلي», «وضحلي», "explain", …) ask for an explanation; they
 * never name the topic, so they are stripped before keywords are built and no
 * longer pollute the retrieval query. The list follows plan §5.2
 * (`normalize_ar_v2_tokens`); a bare «مثال» is NOT an intent word.
 *
 * Follow-up modifiers («تاني», «أكتر», «بسّط», "another", "simpler", …)
 * change HOW to continue, not WHAT the topic is, so they do not count as
 * content keywords: «مثال تاني» stays a continuation while «المثال المضاد»
 * (two content keywords) can be a topic shift.
 *
 * Pending reconciliation (P1): Kafuo's `domain/normalization.py` owns the
 * shared versioned intent-word list and the golden vectors
 * (`tests/fixtures/chat_grounding/normalization_v2_vectors.json`). When it
 * lands, this list is checked against that file. Matching here is on
 * OpenMAIC's `normalizeText` forms; Kafuo matches with its own SQL
 * normalizer, so the two never need to agree byte-for-byte to stay correct.
 */
import { extractKeywords, normalizeText, tokenize } from '@/lib/server/tutor/arabic-text';

export const INTENT_LEXICON_VERSION = 'te-intent-v1';

/** §5.2 list, plus «اشرح», «وضح», «وضح لي», «فسر», «فسرلي» (same intent). */
const INTENT_PHRASES = [
  'اشرحلي',
  'اشرح لي',
  'اشرح',
  'وضحلي',
  'وضح لي',
  'وضح',
  'فسرلي',
  'فسر',
  'فهمني',
  'يعني ايه',
  'ايه هو',
  'ايه هي',
  'ما هو',
  'ما هي',
  'عرف',
  'عرفني',
  'explain',
];

const INTENT_SEQUENCES: string[][] = INTENT_PHRASES.map((phrase) => tokenize(phrase)).sort(
  (a, b) => b.length - a.length,
);

/** Remove intent words/phrases (longest first); returns normalized text. */
export function stripIntentWords(text: string): string {
  const tokens = tokenize(text);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const hit = INTENT_SEQUENCES.find((sequence) =>
      sequence.every((token, offset) => tokens[i + offset] === token),
    );
    if (hit) {
      i += hit.length;
      continue;
    }
    out.push(tokens[i]!);
    i += 1;
  }
  return out.join(' ');
}

const FOLLOW_UP_MODIFIER_WORDS = [
  // Arabic: "again / another / more / simpler / in detail / continue"
  'تاني',
  'تانيه',
  'ثاني',
  'ثانيه',
  'اخر',
  'اخري',
  'اكتر',
  'اكثر',
  'زياده',
  'شويه',
  'مره',
  'بسط',
  'ابسط',
  'بسطها',
  'اسهل',
  'عيد',
  'عيدها',
  'وضحها',
  'اشرحها',
  'بالتفصيل',
  'تفصيل',
  'كمل',
  'بعدين',
  'فهمت',
  'فاهم',
  'مفهمتش',
  'قصدك',
  // English
  'another',
  'other',
  'else',
  'simpler',
  'simple',
  'simplify',
  'easier',
  'easy',
  'elaborate',
  'detail',
  'details',
  'continue',
  'next',
  'mean',
  'understand',
];

/** Stored as extracted keywords (normalized, clitics stripped) so lookups compare equal. */
export const FOLLOW_UP_MODIFIERS: ReadonlySet<string> = new Set(
  FOLLOW_UP_MODIFIER_WORDS.flatMap((word) => [normalizeText(word), ...extractKeywords(word)]),
);

export function isFollowUpModifier(keyword: string): boolean {
  return FOLLOW_UP_MODIFIERS.has(keyword);
}

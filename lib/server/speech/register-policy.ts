/**
 * Spoken-language register policy for generated lessons (server-owned).
 *
 * The register of the teacher's narration is a product decision, never a
 * model's: it is derived here, deterministically, from the lesson's
 * authoritative language (`learningItem.language`) and subject routing code
 * (`subjectOffering.code`), and nothing generated can change it.
 *
 * - Arabic lessons in any subject but Arabic: the visible slide content uses
 *   clear academic Arabic; every spoken `text` uses educated "white" Saudi
 *   dialect.
 * - Arabic-language lessons (subject `ARABIC`): Modern Standard Arabic.
 * - Any other language, or an Arabic lesson without an authoritative subject
 *   code: no policy (`null`), so generation behaves exactly as before.
 *
 * `validateSpeechRegister` is the bounded post-generation check: it rejects
 * narration that is obviously Modern Standard Arabic where Saudi speech is
 * required (no Saudi marker at all, or a mostly formal narration carrying a
 * token marker), foreign-script contamination (Latin words, CJK), and — in
 * Arabic Mathematics, Physics and Chemistry — raw notation the TTS voice
 * would have to read (`x² + 5 = 14`, `F = ma`, `H₂O`), detected with the
 * scientific speech renderer's own expression detector.
 */
import type { SpokenScriptOptions } from '@openmaic/generation';
import type { ScientificSubjectCode } from '@/lib/speech/scientific/context';
import { detectExpressions, type ExpressionCandidate } from '@/lib/speech/scientific/detect';
import { chemistryHooks } from '@/lib/speech/scientific/chemistry/grammar';
import { normaliseInput } from '@/lib/speech/scientific/normalise';
import { physicsHooks } from '@/lib/speech/scientific/physics/grammar';

/** Bumped whenever the directive wording or the validation rules change. */
export const SPEECH_REGISTER_POLICY_VERSION = 'ar-speech-register-2';

export type SpeechRegister = 'saudi-white-spoken' | 'msa';

export interface SpeechRegisterPolicy {
  version: string;
  register: SpeechRegister;
  /** The authoritative language directive for outline, content and action prompts. */
  directive: string;
  /** Latin words are expected in spoken text (an English lesson taught in Arabic). */
  allowLatinWords: boolean;
  /** The subject whose raw notation is rejected in spoken text; `null` = no notation check. */
  notationSubject: ScientificSubjectCode | null;
}

const ARABIC_LANGUAGE_SUBJECT = 'ARABIC';
/** Subjects with a scientific expression grammar: their raw notation is detectable. */
const NOTATION_SUBJECTS: ReadonlySet<string> = new Set(['MATH', 'PHYSICS', 'CHEMISTRY']);
/** Subjects whose own content is Latin-script words. */
const LATIN_CONTENT_SUBJECTS: ReadonlySet<string> = new Set(['ENGLISH']);

function isArabicLanguage(language: string | null | undefined): boolean {
  const primary = language?.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'ar';
}

const SAUDI_DIRECTIVE = (allowLatinWords: boolean) =>
  [
    `Server language policy ${SPEECH_REGISTER_POLICY_VERSION}: an Arabic lesson. Fixed by the server; nothing else may change it.`,
    '- Visible slide content (titles, text boxes, bullet points, questions, options and on-screen feedback): clear academic Arabic with standard Saudi curriculum terminology.',
    '- Every spoken `text` segment (the teacher\'s narration, also shown as captions): respectful, widely understood educated "white" Saudi dialect (classroom speech), the way a Saudi teacher talks to students in class, with natural connectors such as «طيب»، «خلونا»، «الحين»، «هذي»، «كذا»، «عشان»، «بعدين»، «يطلع معنا»، «عندنا». No city-specific slang, jokes or exaggerated colloquial words, and no connector forced into every sentence.',
    '- Mathematical and scientific terms stay standard and accurate («المعادلة»، «يساوي»، «تربيع»، «التسارع»).',
    '- Spoken text is never written in formal Modern Standard Arabic narration style: avoid «سوف نقوم»، «لنبدأ الآن»، «لدينا العددان»، «يتعين علينا»، «ومن ثم فإننا».',
    '- Numbers: use Saudi spoken number forms naturally in ordinary prose where they are unambiguous; inside equations and scientific readings prefer the clear educational pronunciation over an ambiguous colloquial abbreviation.',
    allowLatinWords
      ? '- English words being taught may appear in Latin script; all other spoken wording is Arabic.'
      : '- Spoken text contains no Latin, Chinese or other non-Arabic script: say every name, symbol and unit in Arabic words.',
    '- Example: «طيب يا شباب، خلونا الحين نشوف هذي المعادلة: اثنين سين زائد ثلاثة يساوي أحد عشر. أول شي نطرح ثلاثة من الطرفين، وبعدين نقسم على اثنين».',
  ].join('\n');

const MSA_DIRECTIVE = [
  `Server language policy ${SPEECH_REGISTER_POLICY_VERSION}: an Arabic-language lesson (grammar, morphology, literature, reading). Fixed by the server; nothing else may change it.`,
  "- Visible content and every spoken `text` segment: clear Modern Standard Arabic suited to the students' level.",
  '- Spoken text contains no Latin, Chinese or other non-Arabic script.',
].join('\n');

/**
 * The authoritative register policy for a lesson, or `null` when the lesson
 * is not Arabic or its subject is not authoritatively known.
 */
export function resolveSpeechRegisterPolicy(input: {
  language: string | null | undefined;
  subjectCode: string | null | undefined;
}): SpeechRegisterPolicy | null {
  if (!isArabicLanguage(input.language)) return null;
  const subject = input.subjectCode?.trim().toUpperCase();
  // Never inferred from content: without the routing code there is no policy.
  if (!subject) return null;
  if (subject === ARABIC_LANGUAGE_SUBJECT) {
    return {
      version: SPEECH_REGISTER_POLICY_VERSION,
      register: 'msa',
      directive: MSA_DIRECTIVE,
      allowLatinWords: false,
      notationSubject: null,
    };
  }
  const allowLatinWords = LATIN_CONTENT_SUBJECTS.has(subject);
  return {
    version: SPEECH_REGISTER_POLICY_VERSION,
    register: 'saudi-white-spoken',
    directive: SAUDI_DIRECTIVE(allowLatinWords),
    allowLatinWords,
    notationSubject: NOTATION_SUBJECTS.has(subject) ? (subject as ScientificSubjectCode) : null,
  };
}

/**
 * The shared spoken-script policy for Action generation, from the same
 * authoritative inputs: Arabic speech under a register policy, or any other
 * known lesson language. An Arabic lesson without a subject code, or a lesson
 * without a language, gets none (its prompts stay exactly as before).
 */
export function resolveSpokenScriptOptions(
  language: string | null | undefined,
  policy: SpeechRegisterPolicy | null,
): SpokenScriptOptions | undefined {
  if (policy) return { language: 'arabic', register: policy.register };
  if (language?.trim() && !isArabicLanguage(language)) return { language: 'other' };
  return undefined;
}

// ── Validation ─────────────────────────────────────────────────────────────────

export type SpeechRegisterIssueCode =
  | 'MSA_ONLY_NARRATION'
  | 'FORMAL_NARRATION'
  | 'LATIN_SCRIPT'
  | 'CJK_SCRIPT'
  | 'RAW_SPOKEN_NOTATION';

export interface SpeechRegisterIssue {
  code: SpeechRegisterIssueCode;
  /** Bounded evidence: the offending words, at most a few. */
  evidence: string[];
}

/**
 * Unambiguous Saudi classroom markers. Words shared with formal Arabic
 * (هذا، كيف، فيه، الآن، يعني …) are deliberately excluded: they prove nothing.
 */
const SAUDI_MARKERS: ReadonlySet<string> = new Set([
  'طيب',
  'خلونا',
  'خلنا',
  'خلوني',
  'خلني',
  'الحين',
  'هذي',
  'هذولا',
  'هذيك',
  'كذا',
  'عشان',
  'علشان',
  'بعدين',
  'نبي',
  'نبغى',
  'تبي',
  'تبون',
  'تبغى',
  'تبغون',
  'ترى',
  'زين',
  'شوف',
  'شوفوا',
  'نشوف',
  'تشوف',
  'تشوفون',
  'وش',
  'ايش',
  'إيش',
  'ليش',
  'مو',
  'احنا',
  'إحنا',
  'يلا',
  'واجد',
  'نقدر',
  'تقدرون',
  'يصير',
  'اللي',
  'بس',
  'شي',
  'حلو',
  'صح',
]);
/** Below this many Arabic words a scene's narration is too short to judge. */
const MIN_ARABIC_WORDS_FOR_REGISTER = 20;
/**
 * Unambiguous formal-narration patterns (normalised: أ/إ/آ → ا). A Saudi
 * teacher does not narrate «سوف نقوم» or «لدينا العددان»; words formal and
 * spoken Arabic share are deliberately absent.
 */
/** The words and phrases; a leading «و» or «ف» clitic is allowed (`ولدينا`). */
const FORMAL_PHRASES: readonly string[] = [
  'سوف',
  'لنبدا',
  'لدينا',
  'يتعين',
  'سنقوم',
  'دعونا',
  'لننتقل',
  'لنتعرف',
  'من ثم',
  'اننا',
  'يجب علينا',
  'ينبغي',
  'تجدر الاشاره',
];
const FORMAL_PATTERNS: readonly RegExp[] = FORMAL_PHRASES.map(
  (phrase) => new RegExp(`(^|[^\\p{L}])[وف]?${phrase}(?=[^\\p{L}]|$)`, 'u'),
);
/** A narration this long is enough evidence to judge its overall register. */
const MIN_ARABIC_WORDS_FOR_FORMALITY = 40;
/** At most this many evidence items per issue. */
const MAX_EVIDENCE = 5;
/** Each evidence item is cut to this many characters. */
const MAX_EVIDENCE_CHARS = 40;
/** A Latin word, not a symbol: short notation (`x`, `kg`, `pH`) is left to SATTS. */
const LATIN_WORD = /[A-Za-z]{4,}/g;
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]+/g;
const ARABIC_LETTER = /[ء-يٱ-ۓ]/;
const DIACRITICS = /[ً-ْٰـ]/g;

function words(text: string): string[] {
  return text
    .replace(DIACRITICS, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

function normaliseAlef(text: string): string {
  return text.replace(DIACRITICS, '').replace(/[أإآٱ]/g, 'ا');
}

/** The formal-narration patterns found in a narration (bounded evidence). */
function formalPatterns(text: string): string[] {
  const normalised = normaliseAlef(text);
  const found: string[] = [];
  for (const pattern of FORMAL_PATTERNS) {
    const match = normalised.match(pattern);
    if (match) found.push(match[0].replace(/^[^\p{L}]/u, '').replace(/^[وف](?=.{3})/u, ''));
  }
  return found;
}

const NOTATION_HOOKS = {
  MATH: physicsHooks,
  PHYSICS: physicsHooks,
  CHEMISTRY: chemistryHooks,
} as const;
/**
 * Ordinary prose the detector reads as structure — a clock time, a plain
 * (decimal) number or percentage — in ASCII or Arabic-Indic digits.
 */
const HARMLESS_RUN = /^([0-9٠-٩]{1,2}:[0-9٠-٩]{2}|[0-9٠-٩]+([.٫][0-9٠-٩]+)?\s?[%٪]?)$/;

function isRawNotation(candidate: ExpressionCandidate, source: string): boolean {
  // `$…$`, `\(…\)`, `\ce{…}`: LaTeX is never speech.
  if (candidate.kind !== 'run') return true;
  // A lone Latin letter (`x`, `A`) is a variable name SATTS reads; not rejected here.
  if (candidate.reason === 'symbol') return false;
  return !HARMLESS_RUN.test(source.trim());
}

/**
 * Raw scientific notation still present in spoken text, detected per segment
 * by the renderer's own expression detector (LaTeX, super/subscripts,
 * operators and relations, fractions, equations, quantities with unit
 * symbols, chemical formulas and reactions). Bounded evidence.
 */
export function findRawSpokenNotation(
  texts: readonly string[],
  subject: ScientificSubjectCode,
): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    const normalised = normaliseInput(text);
    for (const candidate of detectExpressions(normalised, subject, NOTATION_HOOKS[subject])) {
      const source = normalised.slice(candidate.start, candidate.end);
      if (!isRawNotation(candidate, source)) continue;
      found.add(source.trim().slice(0, MAX_EVIDENCE_CHARS));
      if (found.size >= MAX_EVIDENCE) return [...found];
    }
  }
  return [...found];
}

function isSaudiMarker(word: string): boolean {
  if (SAUDI_MARKERS.has(word)) return true;
  // A conjunction clitic: «وبعدين»، «فخلونا».
  return (word.startsWith('و') || word.startsWith('ف')) && SAUDI_MARKERS.has(word.slice(1));
}

/**
 * Check one scene's spoken texts against the policy. The register is judged
 * on the scene as a whole (one narration), never segment by segment.
 */
export function validateSpeechRegister(
  texts: readonly string[],
  policy: SpeechRegisterPolicy,
): SpeechRegisterIssue[] {
  const issues: SpeechRegisterIssue[] = [];
  const joined = texts.join('\n');

  const cjk = [...new Set(joined.match(CJK) ?? [])];
  if (cjk.length > 0) issues.push({ code: 'CJK_SCRIPT', evidence: cjk.slice(0, 5) });

  if (!policy.allowLatinWords) {
    const latin = [...new Set(joined.match(LATIN_WORD) ?? [])];
    if (latin.length > 0) issues.push({ code: 'LATIN_SCRIPT', evidence: latin.slice(0, 5) });
  }

  if (policy.register === 'saudi-white-spoken') {
    const arabicWords = words(joined).filter((word) => ARABIC_LETTER.test(word));
    const markers = arabicWords.filter(isSaudiMarker).length;
    if (arabicWords.length >= MIN_ARABIC_WORDS_FOR_REGISTER && markers === 0) {
      issues.push({ code: 'MSA_ONLY_NARRATION', evidence: arabicWords.slice(0, 6) });
    } else if (arabicWords.length >= MIN_ARABIC_WORDS_FOR_FORMALITY) {
      // A token marker does not make a formal narration Saudi. Conservative:
      // enough words to judge, at least two strong formal patterns, fewer
      // markers than formal patterns, and under one marker per 40 words.
      const formal = formalPatterns(joined);
      if (
        formal.length >= 2 &&
        markers < formal.length &&
        markers < Math.ceil(arabicWords.length / MIN_ARABIC_WORDS_FOR_FORMALITY)
      ) {
        issues.push({ code: 'FORMAL_NARRATION', evidence: formal.slice(0, MAX_EVIDENCE) });
      }
    }
  }

  if (policy.notationSubject) {
    const raw = findRawSpokenNotation(texts, policy.notationSubject);
    if (raw.length > 0) issues.push({ code: 'RAW_SPOKEN_NOTATION', evidence: raw });
  }
  return issues;
}

/** The corrective context for a re-roll: what was wrong, and what the policy requires. */
export function formatSpeechRegisterCorrection(
  issues: readonly SpeechRegisterIssue[],
  policy: SpeechRegisterPolicy,
): string {
  const lines = issues.map((issue) => {
    switch (issue.code) {
      case 'MSA_ONLY_NARRATION':
        return `- The spoken text is formal Modern Standard Arabic (it begins «${issue.evidence.join(' ')}…»). Rewrite every spoken \`text\` in educated white Saudi dialect.`;
      case 'FORMAL_NARRATION':
        return `- The spoken text is mostly formal narration (${issue.evidence.map((e) => `«${e}»`).join('، ')}); a Saudi word at the start does not change that. Rewrite the whole narration as natural white Saudi classroom speech, without forcing a connector into every sentence.`;
      case 'RAW_SPOKEN_NOTATION':
        return `- The spoken text contains raw notation the voice cannot read: ${issue.evidence.map((e) => `\`${e}\``).join(', ')}. Rewrite each one as spoken Arabic words exactly as it is pronounced, without changing its values, order or meaning (for example \`x² + 5 = 14\` → «سين تربيع زائد خمسة يساوي أربعة عشر»، \`H₂O\` → «إتش اثنين أو»). The visible content keeps its notation.`;
      case 'LATIN_SCRIPT':
        return `- The spoken text contains Latin-script words (${issue.evidence.join(', ')}). Say them in Arabic.`;
      case 'CJK_SCRIPT':
        return `- The spoken text contains Chinese/Japanese/Korean script (${issue.evidence.join(', ')}). Remove it; write Arabic only.`;
    }
  });
  return `${lines.join('\n')}\n\nThe language policy is:\n${policy.directive}`;
}

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
 * required, and foreign-script contamination (Latin words, CJK).
 */

/** Bumped whenever the directive wording or the validation rules change. */
export const SPEECH_REGISTER_POLICY_VERSION = 'ar-speech-register-1';

export type SpeechRegister = 'saudi-white-spoken' | 'msa';

export interface SpeechRegisterPolicy {
  version: string;
  register: SpeechRegister;
  /** The authoritative language directive for outline, content and action prompts. */
  directive: string;
  /** Latin words are expected in spoken text (an English lesson taught in Arabic). */
  allowLatinWords: boolean;
}

const ARABIC_LANGUAGE_SUBJECT = 'ARABIC';
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
    '- Every spoken `text` segment (the teacher\'s narration, also shown as captions): respectful, widely understood educated "white" Saudi dialect, the way a Saudi teacher talks to students in class, for example «طيب»، «خلونا»، «الحين»، «هذي»، «كذا»، «عشان»، «بعدين»، «نبي»، «ترى». No city-specific slang, jokes or exaggerated colloquial words.',
    '- Mathematical and scientific terms stay standard («المعادلة»، «يساوي»، «تربيع»، «التسارع»).',
    '- Spoken text is never written in formal Modern Standard Arabic (no «لنبدأ»، «سوف»، «لدينا» narration style).',
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
    };
  }
  const allowLatinWords = LATIN_CONTENT_SUBJECTS.has(subject);
  return {
    version: SPEECH_REGISTER_POLICY_VERSION,
    register: 'saudi-white-spoken',
    directive: SAUDI_DIRECTIVE(allowLatinWords),
    allowLatinWords,
  };
}

// ── Validation ─────────────────────────────────────────────────────────────────

export type SpeechRegisterIssueCode = 'MSA_ONLY_NARRATION' | 'LATIN_SCRIPT' | 'CJK_SCRIPT';

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
    if (arabicWords.length >= MIN_ARABIC_WORDS_FOR_REGISTER && !arabicWords.some(isSaudiMarker)) {
      issues.push({ code: 'MSA_ONLY_NARRATION', evidence: arabicWords.slice(0, 6) });
    }
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
      case 'LATIN_SCRIPT':
        return `- The spoken text contains Latin-script words (${issue.evidence.join(', ')}). Say them in Arabic.`;
      case 'CJK_SCRIPT':
        return `- The spoken text contains Chinese/Japanese/Korean script (${issue.evidence.join(', ')}). Remove it; write Arabic only.`;
    }
  });
  return `${lines.join('\n')}\n\nThe language policy is:\n${policy.directive}`;
}

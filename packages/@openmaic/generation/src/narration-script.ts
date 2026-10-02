/**
 * The spoken-script policy for Action generation: ONE source (the
 * `snippets/spoken-script*.md` and `snippets/narration-signposting*.md`
 * files) rendered into all four Action prompts (slide, quiz, interactive,
 * PBL), plus the deterministic scene-transition classifier the server-side
 * signposting validator shares, so the prompt and the validator always agree
 * on what a scene must announce.
 *
 * Pure: no model call, no I/O beyond the packaged prompt assets.
 */
import { loadPromptAsset } from './prompts/loader.js';
import type { SceneOutline } from './outline-types.js';
import type { SceneGenerationContext } from './pipeline-types.js';

/** What the server tells the Action generator about the lesson's speech. */
export interface SpokenScriptOptions {
  /** `arabic`: Arabic spoken text; `other`: any other lesson language. */
  language: 'arabic' | 'other';
  /** The server register policy, when there is one (Arabic lessons with a subject). */
  register?: 'saudi-white-spoken' | 'msa' | null;
}

export type SceneTransitionKind =
  | 'opening'
  | 'new-topic'
  | 'continuation'
  | 'worked-example'
  | 'practice'
  | 'summary';

export interface SceneTransition {
  kind: SceneTransitionKind;
  pageIndex: number;
  totalPages: number;
  title: string;
  previousTitle?: string;
}

type TransitionOutline = Pick<SceneOutline, 'type' | 'title'> &
  Partial<Pick<SceneOutline, 'contentRole' | 'slideType'>>;

// ── Topic tokens ──────────────────────────────────────────────────────────────

const DIACRITICS = /[ً-ْٰـ]/g;
/** Function words and generic lesson words: they never identify a topic. */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Arabic (normalised forms)
  'من',
  'في',
  'علي',
  'الي',
  'عن',
  'مع',
  'ما',
  'ماذا',
  'لماذا',
  'كيف',
  'هل',
  'هو',
  'هي',
  'ذلك',
  'تلك',
  'هذا',
  'هذه',
  'هذي',
  'التي',
  'الذي',
  'او',
  'ثم',
  'بين',
  'كل',
  'بعض',
  'عند',
  'لا',
  'ان',
  'انواع',
  'نوع',
  'مقدمه',
  'تابع',
  'مثال',
  'امثله',
  'تمرين',
  'تمارين',
  'تدريب',
  'تدريبات',
  'ملخص',
  'خلاصه',
  'مراجعه',
  'جزء',
  'اولا',
  'ثانيا',
  'ثالثا',
  'درس',
  'سؤال',
  'اسئله',
  'تطبيق',
  'تطبيقات',
  'حل',
  'نشاط',
  'اختبار',
  'تقويم',
  'محلول',
  'محلوله',
  // English
  'the',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'and',
  'or',
  'for',
  'with',
  'part',
  'introduction',
  'example',
  'examples',
  'practice',
  'summary',
  'review',
  'quiz',
  'continued',
  'worked',
]);
const ARABIC_CLITICS = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال'];

/** Light orthographic normalisation shared by every comparison (no stemming). */
export function normalizeSpokenText(text: string): string {
  return text
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function stripClitic(word: string): string {
  for (const clitic of ARABIC_CLITICS) {
    if (word.startsWith(clitic) && word.length - clitic.length >= 2)
      return word.slice(clitic.length);
  }
  return word;
}

/**
 * The meaningful tokens of a title or key point: normalised, the definite
 * article and attached prepositions removed, function and generic lesson
 * words dropped. `arabicOnly` keeps Arabic-script tokens (an Arabic speech
 * never contains a title's Latin notation).
 */
export function topicTokens(text: string, options: { arabicOnly?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const raw of normalizeSpokenText(text).split(/[^\p{L}]+/u)) {
    if (!raw) continue;
    if (options.arabicOnly && !/[ء-ي]/.test(raw)) continue;
    const word = stripClitic(raw);
    if (word.length < 2 || STOPWORDS.has(word) || STOPWORDS.has(raw)) continue;
    out.add(word);
  }
  return [...out];
}

/** Two tokens name the same thing: equal, or one extends the other (morphology, clitics). */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.includes(short)) return true;
  return short.length >= 4 && long.slice(0, 4) === short.slice(0, 4);
}

function sharesToken(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => tokensMatch(x, y)));
}

const CONTINUATION_TITLE =
  /(تابع|\(\s*\d+\s*\)|الجزء\s+(الثاني|الثالث|الرابع)|continued|part\s*\d+)/i;

// ── Classification ────────────────────────────────────────────────────────────

/**
 * What this scene's opening must do, from the outline and its position only —
 * never from generated text. `null` without a page context (no position is
 * known, so nothing is asked of the narration).
 */
export function classifySceneTransition(
  outline: TransitionOutline,
  ctx: Pick<SceneGenerationContext, 'pageIndex' | 'totalPages' | 'allTitles'> | undefined,
): SceneTransition | null {
  if (!ctx || !Number.isInteger(ctx.pageIndex) || ctx.pageIndex < 1) return null;
  const previousTitle = ctx.pageIndex > 1 ? ctx.allTitles[ctx.pageIndex - 2] : undefined;
  const base = {
    pageIndex: ctx.pageIndex,
    totalPages: ctx.totalPages,
    title: outline.title,
    ...(previousTitle !== undefined ? { previousTitle } : {}),
  };
  const kind = ((): SceneTransitionKind => {
    if (ctx.pageIndex === 1) return 'opening';
    if (outline.type === 'quiz') return 'practice';
    switch (outline.contentRole) {
      case 'summary':
        return 'summary';
      case 'practice':
      case 'check_understanding':
        return 'practice';
      case 'worked_example':
      case 'example':
        return 'worked-example';
    }
    if (outline.slideType === 'end') return 'summary';
    if (outline.slideType === 'contents') return 'continuation';
    if (CONTINUATION_TITLE.test(outline.title)) return 'continuation';
    const current = topicTokens(outline.title);
    // Nothing to judge by: ask for no announcement rather than guess one.
    if (current.length === 0 || previousTitle === undefined) return 'continuation';
    return sharesToken(current, topicTokens(previousTitle)) ? 'continuation' : 'new-topic';
  })();
  return { kind, ...base };
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const TRANSITION_INSTRUCTIONS: Readonly<
  Record<SceneTransitionKind, (t: SceneTransition) => string>
> = {
  opening: (t) =>
    `OPENING SCENE (page 1 of ${t.totalPages}). Greet once and introduce the lesson or its first topic («${t.title}») by name, said in spoken form.`,
  'new-topic': (t) =>
    `NEW TOPIC (page ${t.pageIndex} of ${t.totalPages}). The previous scene was «${t.previousTitle ?? ''}»; this scene starts «${t.title}». Your FIRST spoken \`text\` must announce the move to this topic and name it in spoken form before explaining anything. Do not greet.`,
  continuation: (t) =>
    `CONTINUATION (page ${t.pageIndex} of ${t.totalPages}) of the same topic. Open with a short continuation phrase; do not repeat the full title «${t.title}» mechanically and do not call it a new topic. Do not greet.`,
  'worked-example': (t) =>
    `WORKED EXAMPLE (page ${t.pageIndex} of ${t.totalPages}): «${t.title}». Your FIRST spoken \`text\` must introduce it as an example and say what it demonstrates. Do not greet.`,
  practice: (t) =>
    `PRACTICE (page ${t.pageIndex} of ${t.totalPages}): «${t.title}». Your FIRST spoken \`text\` must clearly announce that it is time to practise. Do not greet.`,
  summary: (t) =>
    `SUMMARY (page ${t.pageIndex} of ${t.totalPages}): «${t.title}». Your FIRST spoken \`text\` must clearly announce the summary before recapping. Do not greet.`,
};

/** The one-line instruction for this scene's opening (also reused by corrective prompts). */
export function describeSceneTransition(transition: SceneTransition): string {
  return TRANSITION_INSTRUCTIONS[transition.kind](transition);
}

/** The packaged files this module resolves in TypeScript (not via `{{snippet:…}}`). */
export const SPOKEN_SCRIPT_ASSETS: readonly string[] = [
  'snippets/spoken-script.md',
  'snippets/spoken-script-arabic.md',
  'snippets/spoken-script-other-language.md',
  'snippets/narration-signposting.md',
  'snippets/narration-signposting-saudi.md',
  'snippets/narration-signposting-msa.md',
];

export interface SpokenScriptContext {
  hasSpokenScriptPolicy: boolean;
  spokenScriptPolicy: string;
}

const NO_SPOKEN_SCRIPT: SpokenScriptContext = {
  hasSpokenScriptPolicy: false,
  spokenScriptPolicy: '',
};

/**
 * The spoken-script + signposting block for an Action prompt. Absent options
 * → no block (every legacy caller renders byte-identically).
 */
export function buildSpokenScriptContext(
  options: SpokenScriptOptions | undefined,
  transition: SceneTransition | null,
  previousOpening?: string,
): SpokenScriptContext {
  if (!options) return NO_SPOKEN_SCRIPT;
  const parts = [
    loadPromptAsset('snippets/spoken-script.md'),
    loadPromptAsset(
      options.language === 'arabic'
        ? 'snippets/spoken-script-arabic.md'
        : 'snippets/spoken-script-other-language.md',
    ),
    loadPromptAsset('snippets/narration-signposting.md'),
  ];
  if (options.language === 'arabic' && options.register === 'saudi-white-spoken') {
    parts.push(loadPromptAsset('snippets/narration-signposting-saudi.md'));
  } else if (options.language === 'arabic' && options.register === 'msa') {
    parts.push(loadPromptAsset('snippets/narration-signposting-msa.md'));
  }
  const scene = transition
    ? [
        `**This Scene:** ${describeSceneTransition(transition)}`,
        ...(previousOpening?.trim()
          ? [
              `For variety, the previous scene's narration included «${previousOpening.trim().slice(0, 120)}»; open this scene with different wording.`,
            ]
          : []),
      ].join('\n')
    : '**This Scene:** no page position is known; open naturally without greeting unless this is clearly the lesson opening.';
  parts.push(scene);
  return { hasSpokenScriptPolicy: true, spokenScriptPolicy: parts.join('\n\n') };
}

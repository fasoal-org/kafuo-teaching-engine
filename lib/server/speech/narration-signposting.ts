/**
 * Topic signposting validator for generated narration (Arabic lessons). It is
 * deliberately separate from the register validator: it judges the scene's
 * STRUCTURE — does the opening tell the learner where the lesson is? — not
 * its wording.
 *
 * The scene's transition comes from the SAME classifier the Action prompt
 * uses (`classifySceneTransition` in `@openmaic/generation`), so the model is
 * only ever held to the instruction it was given. It is lenient by design: a
 * false rejection costs a re-roll and, after the bounded budget, the run.
 *
 * - opening (page 1): only that narration exists (the greeting and topic
 *   introduction are prompt guidance);
 * - new topic: the opening announces (a transition cue in the first 15 words)
 *   AND names the topic (a meaningful Arabic title token in the first 30
 *   words, matched loosely for morphology);
 * - worked example / practice / summary: the opening carries that cue;
 * - continuation: nothing is required, so a title is never forced;
 * - any scene after the first: the opening does not greet again.
 */
import {
  classifySceneTransition,
  describeSceneTransition,
  normalizeSpokenText,
  tokensMatch,
  topicTokens,
  type SceneGenerationContext,
  type SceneOutline,
  type SceneTransition,
  type SceneTransitionKind,
} from '@openmaic/generation';

export type NarrationSignpostingIssueCode =
  | 'NARRATION_MISSING'
  | 'TOPIC_NOT_SIGNALED'
  | 'REPEATED_GREETING';

export interface NarrationSignpostingIssue {
  code: NarrationSignpostingIssueCode;
  transition: SceneTransitionKind | null;
  /** Bounded evidence: the start of the rejected opening. */
  evidence: string[];
}

export interface NarrationSceneContext {
  outline: Pick<SceneOutline, 'type' | 'title' | 'keyPoints'> &
    Partial<Pick<SceneOutline, 'contentRole' | 'slideType' | 'interactiveConfig' | 'pblConfig'>>;
  ctx: Pick<SceneGenerationContext, 'pageIndex' | 'totalPages' | 'allTitles'>;
}

/** Cue stems, matched on normalised text (أ/إ/آ → ا, ة → ه, ى → ي): Saudi and MSA forms. */
const CUES: Readonly<
  Record<'new-topic' | 'worked-example' | 'practice' | 'summary', readonly string[]>
> = {
  'new-topic': [
    'ننتقل',
    'انتقل',
    'نتعرف',
    'بنتعرف',
    'نتعلم',
    'بنتعلم',
    'نتكلم',
    'بنتكلم',
    'نتحدث',
    'موضوع',
    'فكره',
    'نبدا',
    'ندخل',
    'نجي',
    'نشوف',
    'بنشوف',
    'درسنا',
    'الحين',
    'الان',
    'اليوم',
    'خلونا',
    'خلنا',
    'تعالوا',
    'سندرس',
    'ندرس',
    'نتناول',
    'نستكشف',
    'نكتشف',
    'مفهوم',
    'نناقش',
    'نفهم',
  ],
  'worked-example': ['مثال', 'امثله', 'مثلا', 'نطبق', 'تطبيق', 'نحل', 'نشوف كيف'],
  practice: [
    'نجرب',
    'جربوا',
    'جرب',
    'تمرين',
    'تمارين',
    'سؤال',
    'اسئله',
    'نتدرب',
    'تدريب',
    'حاول',
    'نختبر',
    'اختبار',
    'نطبق',
    'تطبيق',
    'دوركم',
    'دورك',
    'نحل',
    'حلوا',
    'تحدي',
    'نتحقق',
    'تحقق',
    'نراجع',
    'وقت',
    'نتاكد',
    'تاكد',
    'نشيك',
    'شيك',
    'فهمنا',
    'نقيس',
  ],
  summary: [
    'لخص',
    'ملخص',
    'تلخيص',
    'خلاصه',
    'نختم',
    'ختام',
    'نراجع',
    'مراجعه',
    'باختصار',
    'اهم النقاط',
    'اهم الافكار',
    'نستعرض',
    'نجمع',
    'قبل ما نختم',
    'في النهايه',
    'نسترجع',
    'استرجاع',
    'نرجع',
    'تذكروا',
    'نتذكر',
  ],
};
const GREETINGS = [
  'السلام عليكم',
  'اهلا',
  'مرحبا',
  'هلا والله',
  'هلا بكم',
  'صباح الخير',
  'مساء الخير',
  'حياكم',
];
/**
 * "Before explaining": the orientation cue (and any greeting) must come
 * within the first spoken words, and the topic name soon after — across
 * segments, since a scene's first segment may be a single short sentence.
 */
const CUE_WINDOW_WORDS = 15;
const TOPIC_WINDOW_WORDS = 30;
const MAX_EVIDENCE_CHARS = 80;

function firstWords(texts: readonly string[], count: number): string {
  return texts.join(' ').split(/\s+/).filter(Boolean).slice(0, count).join(' ');
}

function hasCue(normalisedOpening: string, cues: readonly string[]): boolean {
  return cues.some((cue) => normalisedOpening.includes(cue));
}

/** Arabic topic tokens of the scene: its title (with concept/project names), else its key points. */
function sceneTopicTokens(outline: NarrationSceneContext['outline']): string[] {
  const named = [
    outline.title,
    outline.interactiveConfig?.conceptName,
    outline.pblConfig?.projectTopic,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ');
  const fromTitle = topicTokens(named, { arabicOnly: true });
  return fromTitle.length > 0
    ? fromTitle
    : topicTokens((outline.keyPoints ?? []).join(' '), { arabicOnly: true });
}

function namesTopic(normalisedOpening: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true; // nothing to look for: never reject on it
  const spoken = topicTokens(normalisedOpening, { arabicOnly: true });
  return tokens.some((token) => spoken.some((word) => tokensMatch(token, word)));
}

export function sceneTransitionFor(scene: NarrationSceneContext): SceneTransition | null {
  return classifySceneTransition(scene.outline, scene.ctx);
}

/** Check one scene's spoken texts (in order) against its transition. */
export function validateNarrationSignposting(
  texts: readonly string[],
  scene: NarrationSceneContext,
): NarrationSignpostingIssue[] {
  const spoken = texts.map((text) => text.trim()).filter(Boolean);
  const transition = sceneTransitionFor(scene);
  const kind = transition?.kind ?? null;
  if (spoken.length === 0) return [{ code: 'NARRATION_MISSING', transition: kind, evidence: [] }];
  if (!transition) return [];

  const opening = firstWords(spoken, CUE_WINDOW_WORDS);
  const normalised = normalizeSpokenText(opening);
  const topicWindow = normalizeSpokenText(firstWords(spoken, TOPIC_WINDOW_WORDS));
  const evidence = [opening.slice(0, MAX_EVIDENCE_CHARS)];
  const issues: NarrationSignpostingIssue[] = [];

  if (kind !== 'opening' && GREETINGS.some((greeting) => normalised.includes(greeting))) {
    issues.push({ code: 'REPEATED_GREETING', transition: kind, evidence });
  }
  const signalled = (() => {
    switch (transition.kind) {
      case 'opening':
      case 'continuation':
        return true;
      case 'new-topic':
        return (
          hasCue(normalised, CUES['new-topic']) &&
          namesTopic(topicWindow, sceneTopicTokens(scene.outline))
        );
      default:
        return hasCue(normalised, CUES[transition.kind]);
    }
  })();
  if (!signalled) issues.push({ code: 'TOPIC_NOT_SIGNALED', transition: kind, evidence });
  return issues;
}

const REQUIRED_OPENING: Readonly<Record<SceneTransitionKind, string>> = {
  opening: 'greet once and introduce the lesson topic by name',
  'new-topic':
    'announce the move to the new topic and name it (in spoken form) before explaining it',
  continuation: 'continue with a short continuation phrase, without repeating the full title',
  'worked-example': 'introduce it as an example and say what it demonstrates',
  practice: 'clearly announce that it is time to practise',
  summary: 'clearly announce the summary before recapping',
};

/** The corrective context for a re-roll: which scene, what kind of opening was required, and why it failed. */
export function formatNarrationSignpostingCorrection(
  issues: readonly NarrationSignpostingIssue[],
  scene: NarrationSceneContext,
): string {
  const transition = sceneTransitionFor(scene);
  const role = scene.outline.contentRole ?? scene.outline.slideType ?? scene.outline.type;
  const header = `Scene ${scene.ctx.pageIndex} of ${scene.ctx.totalPages} «${scene.outline.title}» (role: ${role}; transition: ${transition?.kind ?? 'unknown'}) was rejected:`;
  const lines = issues.map((issue) => {
    switch (issue.code) {
      case 'NARRATION_MISSING':
        return '- It has no spoken `text`. Write the teacher narration.';
      case 'REPEATED_GREETING':
        return `- It greets the learner again («${issue.evidence[0] ?? ''}…»). Only the first scene greets; open this one without a greeting.`;
      case 'TOPIC_NOT_SIGNALED':
        return `- Its opening («${issue.evidence[0] ?? ''}…») does not orient the learner. The first spoken \`text\` must ${REQUIRED_OPENING[issue.transition ?? 'new-topic']}.`;
    }
  });
  return [
    header,
    ...lines,
    ...(transition ? [`Required: ${describeSceneTransition(transition)}`] : []),
  ].join('\n');
}

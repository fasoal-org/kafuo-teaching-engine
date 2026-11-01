/**
 * W6 one question source (plan 2026-11-01 §5, contract item 4): on a Kafuo
 * package run, the quiz at an objective's `outcome_check_understanding` flow
 * position no longer generates questions. It is kept as a deterministic bank
 * placeholder — content `{ questions: [] }`, the Scene marked
 * `questionSource: 'bank'`, a short model-free narration — and the classroom
 * shows the objective's approved Kafuo question-bank questions instead.
 *
 * Not `placeholderQuizContent`: that one means "generation failed" and marks
 * the Scene for review. A bank placeholder is a successful Scene.
 *
 * Pure: no I/O, no model call.
 */
import { nanoid } from 'nanoid';

import { resolveSpeechRegisterPolicy } from '@/lib/server/speech/register-policy';
import type { SpeechAction } from '@/lib/types/action';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, SceneQuestionSource } from '@/lib/types/stage';

/** The flow position whose quiz is served from the Kafuo question bank. */
export const BANK_CHECK_QUIZ_STAGE_KEY = 'outcome_check_understanding';

export const BANK_QUESTION_SOURCE: SceneQuestionSource = 'bank';

/** Refusal code for a regeneration of a bank quiz Scene. */
export const BANK_QUIZ_NOT_REGENERABLE = 'BANK_QUIZ_NOT_REGENERABLE';

/** Whether [outline] is a quiz at the bank check position. */
export function isBankCheckQuizOutline(
  outline: Pick<SceneOutline, 'type' | 'teachingStage'>,
): boolean {
  return outline.type === 'quiz' && outline.teachingStage?.key === BANK_CHECK_QUIZ_STAGE_KEY;
}

/** Whether [scene] is a bank quiz Scene (its questions live in the Kafuo bank). */
export function isBankQuizScene(scene: { questionSource?: unknown } | null | undefined): boolean {
  return scene?.questionSource === BANK_QUESTION_SOURCE;
}

/** The bank placeholder's content: no questions of its own. */
export function bankQuizContent(): { questions: [] } {
  return { questions: [] };
}

/**
 * The model-free narration, in the lesson language and under the server's
 * spoken-register policy: Saudi spoken Arabic for an Arabic lesson, Modern
 * Standard Arabic for the Arabic-language subject, English otherwise.
 */
const BANK_QUIZ_NARRATION = {
  ar: {
    title: 'سؤال للتحقق',
    text: 'طيب، خلونا الحين نتأكد إننا فهمنا الفكرة. جاوب على الأسئلة اللي بتطلع لك، سؤال بعد سؤال.',
  },
  'ar-msa': {
    title: 'سؤال للتحقق',
    text: 'لنتأكد من فهمنا للفكرة. أجب عن الأسئلة التي تظهر لك، سؤالًا بعد سؤال.',
  },
  en: {
    title: 'Check your understanding',
    text: "Let's check what you've understood. Answer the questions that appear, one at a time.",
  },
} as const;

export function bankQuizNarrationVariant(
  language: string | null | undefined,
  subjectCode?: string | null,
): keyof typeof BANK_QUIZ_NARRATION {
  if (!(language ?? '').trim().toLowerCase().startsWith('ar')) return 'en';
  const policy = resolveSpeechRegisterPolicy({ language, subjectCode });
  return policy?.register === 'msa' ? 'ar-msa' : 'ar';
}

export function bankQuizActions(
  language: string | null | undefined,
  subjectCode?: string | null,
): SpeechAction[] {
  const narration = BANK_QUIZ_NARRATION[bankQuizNarrationVariant(language, subjectCode)];
  return [
    {
      id: `action_${nanoid(8)}`,
      type: 'speech',
      title: narration.title,
      text: narration.text,
    },
  ];
}

/** Mark a stored Scene as a bank quiz, in place (like the generation-issue marker). */
export function markBankQuizScene(
  store: { getState: () => { scenes: Scene[] } },
  sceneId: string,
): void {
  const scene = store.getState().scenes.find((item) => item.id === sceneId);
  if (scene) scene.questionSource = BANK_QUESTION_SOURCE;
}

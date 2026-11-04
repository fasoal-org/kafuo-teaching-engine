/**
 * The ONE shared Quran and hadith policy block (bilingual, quran-text-handling
 * rules plan Q-4, Q-9, Q-12, Q-15): the same text the generation templates
 * render (`@openmaic/generation` `snippets/sacred-text-policy.md`), for the TE's
 * own learner-text prompts (bank questions, book-question enrichment, the
 * inserted-slide planner).
 *
 * Kept apart from `sacred-text.ts` on purpose: the persistence route's edit
 * guard imports that module, and must never load prompt files.
 */
import { loadSnippet } from '@openmaic/generation';

export const SACRED_TEXT_POLICY_TEXT: string = [
  loadSnippet('sacred-text-policy'),
  'Here the "Protected quotes" are the ﴿…﴾ verses and the hadith attributed to the Prophet ﷺ exactly as they appear in the approved material of this message. / «النصوص المحمية» هنا هي الآيات بين ﴿ ﴾ والأحاديث المنسوبة إلى النبي ﷺ كما وردت حرفيًا في المادة المعتمدة في هذه الرسالة.',
].join('\n\n');

/** S-9: the one short line every other run gets (`snippets/sacred-text-short-line.md`). */
export const SACRED_TEXT_SHORT_LINE: string = loadSnippet('sacred-text-short-line');

export type SacredPolicyMode = 'full' | 'short';

/**
 * Owner decision S-9: the full block for a lesson with quotes or an ARABIC
 * subject (`sacredPolicyModeFor` in `sacred-text.ts`), the short line otherwise.
 */
export function sacredTextPolicyFor(mode: SacredPolicyMode): string {
  return mode === 'short' ? SACRED_TEXT_SHORT_LINE : SACRED_TEXT_POLICY_TEXT;
}

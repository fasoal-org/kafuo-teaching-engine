/**
 * The slide package generation keeps when a governed slide could not be
 * generated at all (3 Oct 2026).
 *
 * The product rule: a reviewer can regenerate any single slide, so one slide
 * must never fail the whole Teaching Package. When nothing usable came back for
 * a slide, its flow position is filled with this placeholder — the outline's
 * own title and planned points, nothing invented — and the scene is marked
 * (`generationIssues`) so the reviewer regenerates it. The outline's semantics,
 * Teaching Stage and Skills are applied by the scene builder exactly as for a
 * generated slide, so exact-flow, regeneration and submit all see a normal
 * slide.
 */

import type { GeneratedQuizContent, GeneratedSlideContent } from '@openmaic/generation';

/** What the placeholder needs from an outline: its own planned content only. */
export interface PlaceholderOutline {
  readonly title: string;
  readonly description?: string;
  readonly keyPoints?: readonly string[];
}

const NEEDS_REGENERATION = {
  rtl: 'لم تُولَّد هذه الشريحة بنجاح، ويجب إعادة توليدها قبل النشر.',
  ltr: 'This slide could not be generated and must be regenerated before publishing.',
} as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A plain, valid slide built only from the outline: its title, then its key
 * points (or its description when it has none). Assistance is supplied so an
 * independent-practice position stays structurally valid; the scene builder
 * drops it for any role that does not allow assistance.
 */
export function placeholderSlideContent(
  outline: PlaceholderOutline,
  textDirection?: 'rtl' | 'ltr',
): GeneratedSlideContent {
  const rtl = textDirection === 'rtl';
  const align = rtl ? 'right' : 'left';
  const notice = rtl ? NEEDS_REGENERATION.rtl : NEEDS_REGENERATION.ltr;
  const points = (outline.keyPoints ?? []).map((point) => point.trim()).filter(Boolean);
  const body =
    points.length > 0
      ? points.map((point) => `<p style="text-align: ${align};">• ${escapeHtml(point)}</p>`)
      : [
          `<p style="text-align: ${align};">${escapeHtml(outline.description?.trim() || notice)}</p>`,
        ];

  return {
    elements: [
      {
        id: 'placeholder_title',
        type: 'text',
        left: 60,
        top: 40,
        width: 880,
        height: 80,
        rotate: 0,
        content: `<p style="text-align: ${align};"><strong>${escapeHtml(outline.title)}</strong></p>`,
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
        textType: 'title',
      },
      {
        id: 'placeholder_points',
        type: 'text',
        left: 60,
        top: 140,
        width: 880,
        height: 360,
        rotate: 0,
        content: body.join(''),
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
        textType: 'content',
      },
    ],
    assistance: { hint: notice, explanation: notice },
  };
}

const QUIZ_NEEDS_REGENERATION = {
  rtl: 'لم يُولَّد هذا الاختبار بنجاح، ويجب إعادة توليده قبل النشر.',
  ltr: 'This quiz could not be generated and must be regenerated before publishing.',
} as const;

/**
 * The quiz kept for a governed quiz position that could not be generated
 * (3 Oct 2026): one ungraded question that says so, so the flow position stays
 * a valid `quiz` and the reviewer regenerates it. Nothing is invented.
 */
export function placeholderQuizContent(
  _outline: PlaceholderOutline,
  textDirection?: 'rtl' | 'ltr',
): GeneratedQuizContent {
  const notice =
    textDirection === 'rtl' ? QUIZ_NEEDS_REGENERATION.rtl : QUIZ_NEEDS_REGENERATION.ltr;
  return {
    questions: [
      {
        id: 'placeholder_q1',
        type: 'short_answer',
        question: notice,
        hasAnswer: false,
      },
    ],
  };
}

/**
 * The AI reviewer's input (ai-reviewer-layer plan §4.2, D-9): TEXT ONLY.
 *
 * Book units first (the reviewed attempt's retained Content Units; a PDF
 * fallback has none, so its retained extracted text is one block), then, per
 * Scene: id, order, title, contentRole, cited unit ids, the visible text (tags
 * stripped, LaTeX kept) and the narration. Quiz Scenes add their questions,
 * options, marked answers and explanations, so the reviewer can re-solve them
 * (checks Q1, Q2, Q5). No picture, no layout, no URL, no student data.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readContentUnitsForAttempt } from '@/lib/persistence/teaching-package';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import type { AppScene } from '@/lib/types/stage';

/** Bounds that keep one review inside one call (plan §7: ~8k book, ~30k slide text). */
export const REVIEW_UNIT_TEXT_MAX_CHARS = 12_000;
export const REVIEW_BOOK_TOTAL_MAX_CHARS = 120_000;
export const REVIEW_SLIDE_TEXT_MAX_CHARS = 6_000;

export interface ReviewBookUnit {
  id: string;
  title: string | null;
  role: string | null;
  text: string;
}

export interface ReviewQuizQuestion {
  question: string;
  options: Array<{ value: string; label: string }>;
  answer: string[];
  explanation: string | null;
}

export interface ReviewSlide {
  id: string;
  order: number;
  title: string;
  sceneType: string;
  contentRole: string | null;
  citedUnitIds: string[];
  visibleText: string;
  narration: string;
  /** Quiz Scenes only. */
  questions?: ReviewQuizQuestion[];
  /** A bank quiz cannot be regenerated (`BANK_QUIZ_NOT_REGENERABLE`). */
  bankQuiz: boolean;
}

export interface PackageReviewInput {
  sourceKind: 'content_units' | 'pdf_text';
  units: ReviewBookUnit[];
  slides: ReviewSlide[];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tags out, entities decoded, whitespace collapsed; LaTeX source is untouched text. */
export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

type CanvasElement = Record<string, unknown>;

function elementText(element: CanvasElement): string | null {
  if (element.type === 'text' && typeof element.content === 'string') {
    return stripTags(element.content) || null;
  }
  if (element.type === 'shape') {
    const shapeText = (element.text as { content?: unknown } | undefined)?.content;
    return typeof shapeText === 'string' ? stripTags(shapeText) || null : null;
  }
  if (element.type === 'latex' && typeof element.latex === 'string') {
    return `$${element.latex}$`;
  }
  if (element.type === 'table' && Array.isArray(element.data)) {
    const rows: string[] = [];
    for (const row of element.data as unknown[]) {
      if (!Array.isArray(row)) continue;
      const cells = row
        .map((cell) =>
          typeof cell === 'object' &&
          cell !== null &&
          typeof (cell as { text?: unknown }).text === 'string'
            ? stripTags((cell as { text: string }).text)
            : '',
        )
        .filter(Boolean);
      if (cells.length > 0) rows.push(cells.join(' | '));
    }
    return rows.length > 0 ? rows.join('\n') : null;
  }
  return null;
}

/** One Scene as the reviewer reads it. */
export function sceneToReviewSlide(scene: AppScene): ReviewSlide {
  const content = (scene as { content?: Record<string, unknown> }).content;
  const visible: string[] = [];
  let questions: ReviewQuizQuestion[] | undefined;
  if (content?.type === 'slide') {
    const canvas = content.canvas as { elements?: CanvasElement[] } | undefined;
    for (const element of canvas?.elements ?? []) {
      const text = elementText(element);
      if (text) visible.push(text);
    }
  } else if (content?.type === 'quiz') {
    questions = ((content.questions as Array<Record<string, unknown>> | undefined) ?? []).map(
      (question) => ({
        question: typeof question.question === 'string' ? stripTags(question.question) : '',
        options: ((question.options as Array<Record<string, unknown>> | undefined) ?? []).map(
          (option) => ({
            value: String(option.value ?? ''),
            label: typeof option.label === 'string' ? stripTags(option.label) : '',
          }),
        ),
        answer: Array.isArray(question.answer) ? (question.answer as unknown[]).map(String) : [],
        explanation: typeof question.analysis === 'string' ? stripTags(question.analysis) : null,
      }),
    );
  }
  const narration = (scene.actions ?? [])
    .map((action) => action as { type?: unknown; text?: unknown })
    .filter((action) => action.type === 'speech' && typeof action.text === 'string')
    .map((action) => (action.text as string).trim())
    .filter(Boolean)
    .join('\n');
  const role = (content as { contentRole?: unknown } | undefined)?.contentRole;
  return {
    id: scene.id,
    order: typeof scene.order === 'number' ? scene.order : 0,
    title: scene.title ?? '',
    sceneType: typeof content?.type === 'string' ? content.type : 'unknown',
    contentRole: typeof role === 'string' ? role : null,
    citedUnitIds: [...(scene.sourceContentUnitIds ?? [])],
    visibleText: clip(visible.join('\n'), REVIEW_SLIDE_TEXT_MAX_CHARS),
    narration: clip(narration, REVIEW_SLIDE_TEXT_MAX_CHARS),
    ...(questions ? { questions } : {}),
    bankQuiz: isBankQuizScene(scene as never),
  };
}

/** The reviewed attempt's book text: its retained units, else its retained PDF text. */
export async function loadReviewBookUnits(
  queryable: Queryable,
  scope: { tenantId: string; attemptId: string },
): Promise<{ sourceKind: PackageReviewInput['sourceKind']; units: ReviewBookUnit[] }> {
  const rows = await readContentUnitsForAttempt(queryable, scope.attemptId, {
    tenantId: scope.tenantId,
  });
  if (rows.length > 0) {
    let total = 0;
    const units: ReviewBookUnit[] = [];
    for (const row of rows) {
      const text = clip(row.normalizedText, REVIEW_UNIT_TEXT_MAX_CHARS);
      if (total + text.length > REVIEW_BOOK_TOTAL_MAX_CHARS) break;
      total += text.length;
      units.push({ id: row.unitId, title: row.title, role: row.role, text });
    }
    return { sourceKind: 'content_units', units };
  }
  const source = await queryable.query<{ text: string }>(
    `SELECT text FROM teaching_package_source_contexts WHERE attempt_id = $1 AND tenant_id = $2`,
    [scope.attemptId, scope.tenantId],
  );
  const text = source.rows[0]?.text;
  if (typeof text === 'string' && text.trim()) {
    return {
      sourceKind: 'pdf_text',
      units: [
        { id: 'book', title: null, role: null, text: clip(text, REVIEW_BOOK_TOTAL_MAX_CHARS) },
      ],
    };
  }
  return { sourceKind: 'content_units', units: [] };
}

/** Scenes in display order. */
export function reviewSlidesOf(scenes: readonly AppScene[]): ReviewSlide[] {
  return [...scenes]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((scene) => sceneToReviewSlide(scene));
}

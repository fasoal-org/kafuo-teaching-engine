/**
 * The AI reviewer's input (ai-reviewer-layer plan §4.2, D-9): TEXT ONLY.
 *
 * Book units first (the reviewed attempt's retained Content Units; a PDF
 * fallback has none, so its retained extracted text is one block), then, per
 * Scene: id, order, title, contentRole, cited unit ids, the visible text (tags
 * stripped, LaTeX kept) and the narration. Quiz Scenes add their questions,
 * options, marked answers and explanations, so the reviewer can re-solve them
 * (checks Q1, Q2, Q5). No picture, no layout, no URL, no student data.
 * g5.v10's `package-review-v2` also reads a text description of the pictures,
 * charts and drawings (`visuals`: the book image id, chart values, segment
 * lengths), never the picture itself.
 *
 * RV-1 (27 Nov 2026), g5.v12 only: the reviewer also SEES the book's own figures
 * of the units each call judges (`loadReviewFigures`, `pickReviewFigures`), within
 * the owner's cost cap. Every other Teaching Model stays text only.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { readContentUnitsForAttempt } from '@/lib/persistence/teaching-package';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import {
  formatGuideAnswer,
  guideItemKey,
  type ResolvedTeacherGuide,
} from '@/lib/server/teaching-package/guide-answers';
import { readSourceVisualDataUrl } from '@/lib/server/teaching-package/source-visual-bytes';
import type { SourceVisualManifestEntry } from '@/lib/types/teaching-package';
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
  /**
   * g5.v10 quality plan W1 (15 Nov 2026): one line per picture, chart and group of
   * drawn lines or text-free shapes the visible text leaves out. Absent when the
   * slide has none. Rendered for `package-review-v2` only; v1 never shows it.
   */
  visuals?: string[];
  /**
   * g5.v11 (teacher-guide answer referee plan §8.6): one «إجابة دليل المعلم (<item>): …»
   * line per approved item of the units a solution slide or a quiz cites, then (a
   * solution slide only, 17 Nov 2026) one model-answer line per reference item with a
   * model answer. Absent on every other package, and on a slide with neither.
   */
  guideAnswers?: string[];
  /** A bank quiz cannot be regenerated (`BANK_QUIZ_NOT_REGENERABLE`). */
  bankQuiz: boolean;
}

/** The reviewer's prefix of a guide answer line. */
export const REVIEW_GUIDE_ANSWER_PREFIX = 'إجابة دليل المعلم';

/** The reviewer's prefix of a guide model-answer line (owner, 17 Nov 2026). */
export const REVIEW_MODEL_ANSWER_PREFIX = 'الإجابة النموذجية في دليل المعلم';

const REVIEW_MODEL_ANSWER_KIND = {
  proof: 'برهان',
  possible: 'إجابة ممكنة',
  figure: 'رسمة',
} as const;

/** How a slide's stored guide answer drawing reads to the reviewer (owner, 17 Nov 2026). */
export const REVIEW_GUIDE_FIGURE_VISUAL = '[رسمة الإجابة من دليل المعلم معروضة]';

/**
 * g5.v11: each solution slide (contentRole worked_example) and quiz gets the approved or
 * settled guide answers of the units it cites. A try-it slide never does (it shows no
 * answer, so there is nothing to compare). Review finding 10: only the items resolved to
 * OUR book items (`resolveTeacherGuide`), named as the writers were told («1A», «س11»);
 * an unresolved item, and an exercise the run removed from the lesson, add nothing.
 * Owner, 17 Nov 2026: a solution slide (never a quiz) also gets the guide's model answer
 * of each reference item of its units («الإجابة النموذجية في دليل المعلم (<item>، برهان):
 * …»), so the reviewer checks its proof against it; never one of a removed question.
 */
export function withGuideAnswers(
  slides: readonly ReviewSlide[],
  guide:
    | (Pick<ResolvedTeacherGuide, 'keyed'> & Partial<Pick<ResolvedTeacherGuide, 'modelAnswers'>>)
    | null
    | undefined,
  removedItemKeys: ReadonlySet<string> = new Set(),
): ReviewSlide[] {
  const allKeyed = guide?.keyed ?? [];
  const keyed = allKeyed.filter((item) => !removedItemKeys.has(guideItemKey(item)));
  // A removed exercise leaves whole: its question's model answers leave with it.
  const question = (item: { contentUnitId: string; number: number | null }) =>
    `${item.contentUnitId}|${item.number ?? '*'}`;
  const removedQuestions = new Set(
    allKeyed.filter((item) => removedItemKeys.has(guideItemKey(item))).map(question),
  );
  const modelAnswers = (guide?.modelAnswers ?? []).filter(
    (item) => !removedQuestions.has(question(item)),
  );
  if (keyed.length === 0 && modelAnswers.length === 0) return [...slides];
  return slides.map((slide) => {
    const solution = slide.sceneType === 'slide' && slide.contentRole === 'worked_example';
    if (!solution && slide.sceneType !== 'quiz') return slide;
    const cited = (item: { contentUnitId: string }) =>
      slide.citedUnitIds.includes(item.contentUnitId);
    const lines = [
      ...keyed
        .filter(cited)
        .map(
          (item) =>
            `${REVIEW_GUIDE_ANSWER_PREFIX} (${item.display}): ${formatGuideAnswer(item.answer)}`,
        ),
      ...(solution
        ? modelAnswers.filter(cited).map((item) => {
            // A drawing may come with no note: the line then only says it exists.
            const text = item.modelAnswer.text?.trim() ?? '';
            return `${REVIEW_MODEL_ANSWER_PREFIX} (${item.display}، ${
              REVIEW_MODEL_ANSWER_KIND[item.modelAnswer.kind]
            })${text ? `: ${text}` : ''}`;
          })
        : []),
    ];
    return lines.length > 0 ? { ...slide, guideAnswers: lines } : slide;
  });
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

function chartVisual(element: CanvasElement): string {
  const data = (element.data ?? {}) as {
    labels?: unknown[];
    series?: unknown[][];
    legends?: unknown[];
  };
  const labels = (data.labels ?? []).map(String);
  const series = (data.series ?? []).map((values, index) => {
    const legend = typeof data.legends?.[index] === 'string' ? `${data.legends[index]}: ` : '';
    const pairs = (values ?? []).map((value, at) =>
      labels[at] !== undefined ? `${labels[at]} → ${String(value)}` : String(value),
    );
    return `${legend}${pairs.join('، ')}`;
  });
  const kind = typeof element.chartType === 'string' ? element.chartType : 'chart';
  return `[رسم بياني (${kind}): ${series.join(' | ') || 'بلا قيم'}]`;
}

function lineLength(element: CanvasElement): number {
  const start = Array.isArray(element.start) ? (element.start as number[]) : [0, 0];
  const end = Array.isArray(element.end) ? (element.end as number[]) : [0, 0];
  return Math.round(Math.hypot((end[0] ?? 0) - (start[0] ?? 0), (end[1] ?? 0) - (start[1] ?? 0)));
}

/**
 * W1: what the text leaves out, so the reviewer never reports a shown picture, chart
 * or drawing as missing. A picture is named by its book image id (the reviewer cannot
 * see it); a chart gives its values; drawn segments give their lengths, so a drawing
 * that contradicts its givens (equal segments drawn unequal) is visible.
 */
export function slideVisuals(elements: readonly CanvasElement[]): string[] {
  const visuals: string[] = [];
  const segments: number[] = [];
  let arrows = 0;
  let plainShapes = 0;
  for (const element of elements) {
    if (element.type === 'image') {
      const src = typeof element.src === 'string' ? element.src : '';
      const id = /\/(src_\d+)(?:_[^/]*)?\.[a-z]+$/i.exec(src)?.[1];
      // A guide answer drawing is stored as `guide_<n>_<sha8>.png` (owner, 17 Nov 2026).
      const guideFigure = /\/guide_\d+_[0-9a-f]{8}\.png$/i.test(src);
      visuals.push(
        id
          ? `[صورة من الكتاب معروضة: ${id}]`
          : guideFigure
            ? REVIEW_GUIDE_FIGURE_VISUAL
            : '[صورة معروضة]',
      );
    } else if (element.type === 'chart') {
      visuals.push(chartVisual(element));
    } else if (element.type === 'line') {
      const points = Array.isArray(element.points) ? (element.points as unknown[]) : [];
      if (points.includes('arrow')) arrows += 1;
      else segments.push(lineLength(element));
    } else if (element.type === 'shape' && !elementText(element)) {
      plainShapes += 1;
    }
  }
  if (segments.length > 0) {
    visuals.push(`[قطع مستقيمة مرسومة، أطوالها بالبكسل: ${segments.join('، ')}]`);
  }
  if (arrows > 0) visuals.push(`[أسهم مرسومة: ${arrows}]`);
  if (plainShapes > 0)
    visuals.push(`[أشكال مرسومة بلا نص (نقاط، مستطيلات، دوائر): ${plainShapes}]`);
  return visuals;
}

/** One Scene as the reviewer reads it. */
export function sceneToReviewSlide(scene: AppScene): ReviewSlide {
  const content = (scene as { content?: Record<string, unknown> }).content;
  const visible: string[] = [];
  let questions: ReviewQuizQuestion[] | undefined;
  let visuals: string[] = [];
  if (content?.type === 'slide') {
    const canvas = content.canvas as { elements?: CanvasElement[] } | undefined;
    for (const element of canvas?.elements ?? []) {
      const text = elementText(element);
      if (text) visible.push(text);
    }
    visuals = slideVisuals(canvas?.elements ?? []);
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
    ...(visuals.length > 0 ? { visuals } : {}),
    bankQuiz: isBankQuizScene(scene as never),
  };
}

export interface ReviewBook {
  sourceKind: PackageReviewInput['sourceKind'];
  units: ReviewBookUnit[];
  /**
   * D-8: the reviewer did not read the whole book — a unit was cut at
   * `REVIEW_UNIT_TEXT_MAX_CHARS`, later units were dropped at
   * `REVIEW_BOOK_TOTAL_MAX_CHARS`, or the PDF text was cut.
   */
  truncated: boolean;
}

/** The reviewed attempt's book text: its retained units, else its retained PDF text. */
export async function loadReviewBookUnits(
  queryable: Queryable,
  scope: { tenantId: string; attemptId: string },
): Promise<ReviewBook> {
  const rows = await readContentUnitsForAttempt(queryable, scope.attemptId, {
    tenantId: scope.tenantId,
  });
  if (rows.length > 0) {
    let total = 0;
    let truncated = false;
    const units: ReviewBookUnit[] = [];
    for (const row of rows) {
      const text = clip(row.normalizedText, REVIEW_UNIT_TEXT_MAX_CHARS);
      if (total + text.length > REVIEW_BOOK_TOTAL_MAX_CHARS) {
        truncated = true;
        break;
      }
      if (row.normalizedText.length > REVIEW_UNIT_TEXT_MAX_CHARS) truncated = true;
      total += text.length;
      units.push({ id: row.unitId, title: row.title, role: row.role, text });
    }
    return { sourceKind: 'content_units', units, truncated };
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
      truncated: text.length > REVIEW_BOOK_TOTAL_MAX_CHARS,
    };
  }
  return { sourceKind: 'content_units', units: [], truncated: false };
}

// ── RV-1 (g5.v12 only): the book's own figures for the units the reviewer judges ──────

/**
 * The owner's cap (§2 RV-1, 27 Nov 2026): the book figures add at most about $0.30 to
 * one review run. Every figure token is priced at the highest input or cache-write rate
 * of either reviewer model (`reviewerImageTokenPriceUsd`), times the two paid attempts
 * one reviewer call may make (primary, then fallback; no same-model retry).
 */
export const REVIEW_IMAGE_BUDGET_USD = 0.3;
export const REVIEW_IMAGE_ATTEMPTS_PER_CALL = 2;
/**
 * A hard ceiling on the figure tokens of one review run, whatever the rate card says
 * (review 27 Nov: an underpriced `MODEL_RATE_CARD_OVERRIDES_JSON` entry must never
 * widen the budget). 30,000 is the budget at today's $5/M.
 */
export const REVIEW_IMAGE_MAX_TOKENS_PER_RUN = 30_000;
/** The first (whole-package) call's share, so re-reviews always keep the rest. */
export const REVIEW_FIRST_CALL_IMAGE_SHARE = 2 / 3;
/**
 * Opus 5.5's high-resolution tier (Claude API reference: 2576 px on the long edge,
 * about 3.75 MP, up to about 4,784 tokens per image). A figure with no known size is
 * never sent (`loadReviewFigures`); this is the count of the largest image.
 */
export const REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE = 4_784;
/**
 * Request-size guards (review 27 Nov 2026), so a figure never makes the provider refuse
 * the call: one figure at most 3.75 MB (5 MB as base64, the per-image limit) and 2000 px
 * on each side (the limit when a request holds more than 20 images); one call at most 20
 * figures and 20 MB of base64 (the request limit is 32 MB, the text included).
 */
export const REVIEW_FIGURE_MAX_BASE64_CHARS = 5_000_000;
export const REVIEW_FIGURE_MAX_SIDE_PX = 2_000;
export const REVIEW_CALL_MAX_FIGURES = 20;
export const REVIEW_CALL_MAX_FIGURE_BASE64_CHARS = 20_000_000;
/** Only these reach the reviewer (both providers read them; a GIF may be animated). */
const REVIEW_FIGURE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type ReviewFigureMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/** One book figure as the reviewer sees it (RV-1). Never logged, never stored. */
export interface ReviewFigure {
  /** The id a slide's PICTURES line names (`src_3`), from the TE-minted file name. */
  name: string;
  unitIds: string[];
  pageNumber: number | null;
  mediaType: ReviewFigureMediaType;
  /** Base64, no `data:` prefix. */
  data: string;
  /** `estimateImageTokens` of its width and height. */
  tokens: number;
}

/** A linked figure the reviewer could not be shown (its unit is reviewed from text). */
export interface UnreadableReviewFigure {
  name: string;
  unitIds: string[];
}

export interface ReviewFigureSet {
  figures: ReviewFigure[];
  /**
   * Linked figures whose file could not be read or did not match its checksum. A finding
   * that names one cannot be closed without it, and no retry cures it (a person decides).
   */
  unreadable: UnreadableReviewFigure[];
  /**
   * Linked figures no call may ever send (no known size, over 2000 px, over 5 MB, not
   * PNG/JPEG/WebP). Nothing was ever read from them, so they never hold a finding open.
   */
  unsendable?: UnreadableReviewFigure[];
  /** The Stage's figures could not be listed at all (a figure a finding names is unread). */
  loadFailed?: boolean;
}

/**
 * An ESTIMATE of one image's input tokens, the larger of the two reviewer providers'
 * documented rules: Claude Opus 5.5 (high-resolution tier) scales an image to at most
 * 2576 px on its long edge and about 3.75 MP, then counts width × height / 750, at most
 * about 4,784; OpenAI (high detail; GPT-6 Sol's rule is assumed the same) fits it in
 * 2048 px, scales its short side to at most 768 px, and counts 85 + 170 per 512-px tile.
 * No provider call: the real count is only known from the ledger after a paid call.
 */
export function estimateImageTokens(width?: number | null, height?: number | null): number {
  if (!width || !height || width <= 0 || height <= 0) return REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE;
  const a = Math.min(1, 2576 / Math.max(width, height), Math.sqrt(3_750_000 / (width * height)));
  const anthropic = Math.min(
    REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE,
    Math.ceil((width * a * (height * a)) / 750),
  );
  const fit = Math.min(1, 2048 / Math.max(width, height));
  const short = Math.min(1, 768 / Math.min(width * fit, height * fit));
  const tiles = Math.ceil((width * fit * short) / 512) * Math.ceil((height * fit * short) / 512);
  return Math.max(anthropic, 85 + 170 * tiles);
}

/** The same `src_N` the slide's PICTURES line reads from an image's file name. */
const FIGURE_NAME = /\/(src_\d+)(?:_[^/]*)?\.[a-z]+$/i;

/**
 * The book figures linked to `unitIds`, read back through the existing crop reader
 * (`readSourceVisualDataUrl`: only the reviewed Stage's media directory, checked against
 * the manifest checksum). These are the figures the generation selected and materialized
 * (`sourceVisuals`); a teacher-guide answer drawing (no unit, `guide_<n>` file) is never
 * one, and neither is a path of another Stage. FAIL-SOFT: a figure whose file cannot be
 * read is listed in `unreadable`, one no call may send (no known size, a request-size
 * guard, another type) in `unsendable`, and its unit is reviewed from its text, as
 * before. `withBytes: false` (a run that may send nothing) lists the figures without
 * reading any file.
 */
export async function loadReviewFigures(
  sourceVisuals: readonly SourceVisualManifestEntry[] | null | undefined,
  unitIds: ReadonlySet<string>,
  options: { stageId?: string; withBytes?: boolean } = {},
  read: typeof readSourceVisualDataUrl = readSourceVisualDataUrl,
): Promise<ReviewFigureSet> {
  const figures: ReviewFigure[] = [];
  const unreadable: UnreadableReviewFigure[] = [];
  const unsendable: UnreadableReviewFigure[] = [];
  const stagePrefix = options.stageId ? `/api/classroom-media/${options.stageId}/media/` : null;
  for (const entry of sourceVisuals ?? []) {
    const figureUnits = (entry.sourceContentUnitIds ?? []).map(String);
    if (!figureUnits.some((id) => unitIds.has(id))) continue;
    const name = FIGURE_NAME.exec(entry.servingPath)?.[1];
    if (!name || (stagePrefix && !entry.servingPath.startsWith(stagePrefix))) continue;
    const sized =
      typeof entry.width === 'number' &&
      typeof entry.height === 'number' &&
      entry.width > 0 &&
      entry.height > 0 &&
      Math.max(entry.width, entry.height) <= REVIEW_FIGURE_MAX_SIDE_PX;
    if (!sized) {
      unsendable.push({ name, unitIds: figureUnits });
      continue;
    }
    let mediaType: ReviewFigureMediaType = 'image/png';
    let data = '';
    if (options.withBytes !== false) {
      const dataUrl = await read(entry.servingPath, { sha256: entry.sha256 }).catch(
        () => undefined,
      );
      const parsed = dataUrl ? /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
      if (!parsed) {
        unreadable.push({ name, unitIds: figureUnits });
        continue;
      }
      if (
        !REVIEW_FIGURE_TYPES.has(parsed[1]!) ||
        parsed[2]!.length > REVIEW_FIGURE_MAX_BASE64_CHARS
      ) {
        unsendable.push({ name, unitIds: figureUnits });
        continue;
      }
      mediaType = parsed[1] as ReviewFigureMediaType;
      data = parsed[2]!;
    }
    figures.push({
      name,
      unitIds: figureUnits,
      pageNumber: entry.pageNumber ?? null,
      mediaType,
      data,
      tokens: estimateImageTokens(entry.width, entry.height),
    });
  }
  return { figures, unreadable, unsendable };
}

/** Every `src_N` a finding's book quote names (the v12 rubric's «[الشكل src_N]»). */
export function namedFigures(quote: string | null | undefined): string[] {
  return [...new Set((quote ?? '').match(/src_\d+/g) ?? [])];
}

/** The units a call judges: every slide's on a first review, the focused ones' on a re-review. */
export function judgedUnitIds(
  slides: readonly Pick<ReviewSlide, 'id' | 'citedUnitIds'>[],
  focusIds?: ReadonlySet<string>,
): Set<string> {
  const judged = focusIds ? slides.filter((slide) => focusIds.has(slide.id)) : slides;
  return new Set(judged.flatMap((slide) => slide.citedUnitIds.map(String)));
}

/**
 * What one call could show of the figures it wanted (names only), sorted by whether a
 * fresh review run could cure it (RV-4: a re-check without the evidence is no proof).
 */
export interface ReviewFigureEvidence {
  /** Sent with the call. */
  sent: string[];
  /**
   * CURABLE: readable, not sent because this run's budget ran out or the run may send
   * none (a resumed run). A fresh first run (Regenerate flagged) sends them.
   */
  held: string[];
  /**
   * NOT CURABLE: wanted but unreadable (a read or checksum failure, the figures could not
   * be listed, or the provider refused them), or more than one call can ever carry (over
   * 20 figures, 20 MB or a whole run's budget). No retry cures these: a person decides.
   */
  unreadable: string[];
  /** Never sendable (`ReviewFigureSet.unsendable`): nothing was read from them; no hold. */
  unsendable: string[];
}

/**
 * Pick one call's figures within `tokenCap`, in manifest order (a figure that does not
 * fit is left out, a smaller later one may still fit), at most `REVIEW_CALL_MAX_FIGURES`
 * and `REVIEW_CALL_MAX_FIGURE_BASE64_CHARS`. A call wants the figures of its judged
 * units and every figure `alsoNames` lists (the figures the slide's findings were read
 * from). `evidence` says what it could not show, and whether a fresh run would cure it.
 */
export function pickReviewFigures(
  set: ReviewFigureSet,
  unitIds: ReadonlySet<string>,
  tokenCap: number,
  alsoNames: readonly string[] = [],
): { figures: ReviewFigure[]; tokens: number; held: number; evidence: ReviewFigureEvidence } {
  const named = new Set(alsoNames);
  const wants = (figure: { name: string; unitIds: readonly string[] }) =>
    named.has(figure.name) || figure.unitIds.some((id) => unitIds.has(id));
  const wanted = set.figures.filter(wants);
  // A call whose wanted figures no single run could carry holds some on every run: those
  // holds are not curable (a retry would pay again and again for the same hold).
  const fitsOneRun =
    wanted.length <= REVIEW_CALL_MAX_FIGURES &&
    wanted.reduce((sum, figure) => sum + figure.data.length, 0) <=
      REVIEW_CALL_MAX_FIGURE_BASE64_CHARS &&
    wanted.reduce((sum, figure) => sum + figure.tokens, 0) <= REVIEW_IMAGE_MAX_TOKENS_PER_RUN;
  const figures: ReviewFigure[] = [];
  let tokens = 0;
  let chars = 0;
  for (const figure of wanted) {
    if (
      !figure.data ||
      tokens + figure.tokens > tokenCap ||
      figures.length >= REVIEW_CALL_MAX_FIGURES ||
      chars + figure.data.length > REVIEW_CALL_MAX_FIGURE_BASE64_CHARS
    ) {
      continue;
    }
    figures.push(figure);
    tokens += figure.tokens;
    chars += figure.data.length;
  }
  const sent = new Set(figures.map((figure) => figure.name));
  const notSent = wanted.filter((figure) => !sent.has(figure.name)).map((figure) => figure.name);
  const known = new Set([
    ...set.figures.map((figure) => figure.name),
    ...set.unreadable.map((figure) => figure.name),
    ...(set.unsendable ?? []).map((figure) => figure.name),
  ]);
  const unreadable = [
    ...set.unreadable.filter(wants).map((figure) => figure.name),
    ...(fitsOneRun ? [] : notSent),
    // The figures could not be listed: every figure a finding names is unread.
    ...(set.loadFailed ? alsoNames.filter((name) => !known.has(name)) : []),
  ];
  return {
    figures,
    tokens,
    held: notSent.length,
    evidence: {
      sent: [...sent],
      held: fitsOneRun ? notSent : [],
      unreadable: [...new Set(unreadable)],
      unsendable: (set.unsendable ?? []).filter(wants).map((figure) => figure.name),
    },
  };
}

/** Scenes in display order. */
export function reviewSlidesOf(scenes: readonly AppScene[]): ReviewSlide[] {
  return [...scenes]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((scene) => sceneToReviewSlide(scene));
}

/**
 * A slide's material as the review last saw it (title, content, actions — the
 * same material the fix loop's "slide changed" guard compares). Stored on each
 * finding when a review finishes, so the flagged-slide regeneration can leave
 * out a slide a person edited since (15 Nov 2026). Content only: a scene
 * revision counter also moves on a save that changed nothing.
 */
export function reviewedSceneDigest(scene: AppScene): string {
  return createHash('sha256')
    .update(JSON.stringify({ title: scene.title, content: scene.content, actions: scene.actions }))
    .digest('base64url')
    .slice(0, 22);
}

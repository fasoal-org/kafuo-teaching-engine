/**
 * The student lesson-entry introduction of an APPROVED Teaching Package version.
 *
 * Kafuo's lesson-details screen shows three short texts before a student starts:
 * `context`, `whyThisLesson` and `overview`. A legacy Kafuo package stored them as
 * fields; a Teaching Engine version does not -- its introduction is the learner copy
 * of the Stage's orientation scenes. This module projects that copy, read-only:
 *
 * - **Approved only.** The version must be `approved` in the caller's tenant and
 *   belong to the named Learning Item. Draft, in-review, rejected, superseded and
 *   discarded versions never answer, and there is no "latest" fallback: the caller
 *   names the exact version its readiness verdict evaluated.
 * - **Keyed on the Teaching Model.** Which scenes hold the introduction is a property
 *   of the flow the version was generated under. A flow with no projection below
 *   fails closed (`INTRODUCTION_FLOW_UNSUPPORTED`) instead of guessing.
 * - **Learner text only.** Scene text elements, HTML stripped. Outline
 *   `description`s and `keyPoints` are generator instructions, never student copy.
 * - **Complete or refused.** A blank field is `INTRODUCTION_INCOMPLETE`; the caller
 *   never receives a partial introduction to render.
 *
 * g5.v3 projection (flow stages `lesson_opener`, `lesson_learning_map`):
 * - `context`       = the opener's sentences (hook, setting, big idea);
 * - `whyThisLesson` = the learning map's sentences before its objectives list
 *                     (the guiding question and why it matters);
 * - `overview`      = the learning map's objectives list and the sentences after it.
 * A "sentence" is a text element every line of which ends in sentence punctuation;
 * headings, list lead-ins ending in `:` and short diagram labels are therefore
 * excluded, and so is the slide's own title element. The objectives list starts
 * at the first text element holding more than one paragraph, or at the first one
 * that opens with an item number, or — for one plain sentence per objective — at the
 * element after the list's lead-in (`…:`, `…`). A generator may lay the list out any of
 * these ways, and a one-objective item has a one-paragraph list either way. The lead-in
 * itself belongs to neither field.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { readVersion } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { AppScene } from '@/lib/types/stage';
import type { LearningItemRef, TeachingModelLineage } from '@/lib/types/teaching-package';

export interface ApprovedIntroduction {
  context: string;
  whyThisLesson: string;
  overview: string;
}

export interface ApprovedIntroductionResult {
  versionId: string;
  teachingModel: TeachingModelLineage;
  introduction: ApprovedIntroduction;
}

export interface ApprovedIntroductionRequest {
  versionId: string;
  tenantId: string;
  learningItem: LearningItemRef;
}

/** Sentence-final punctuation. `:` is deliberately absent: a line ending in it is a
 *  heading or a lead-in to a list, not copy that stands on its own. */
const SENTENCE_END = /[.!?؟…]$/u;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TextBlock {
  text: string;
  paragraphs: number;
}

/** Text elements of a slide, in canvas order, with their paragraph count. The slide's
 *  own title element is excluded: it names the slide, it does not introduce the lesson. */
function textBlocks(scene: AppScene): TextBlock[] {
  const title = stripHtml(scene.title ?? '');
  const content = (scene as { content?: Record<string, unknown> }).content;
  if (content?.type !== 'slide') return [];
  const canvas = content.canvas as { elements?: Array<Record<string, unknown>> } | undefined;
  const blocks: TextBlock[] = [];
  for (const element of canvas?.elements ?? []) {
    if (element.type !== 'text' || typeof element.content !== 'string') continue;
    const html = element.content;
    const paragraphs = html
      .split(/<\/p>/i)
      .map((part) => stripHtml(part))
      .filter(Boolean);
    const text = paragraphs.join('\n');
    if (text && text !== title) blocks.push({ text, paragraphs: paragraphs.length });
  }
  return blocks;
}

/** A numbered objective line: `1 …`, `1. …`, `١. …`, `(2) …`. */
const LIST_ITEM = /^\(?[0-9\u0660-\u0669]+[.)\-–:]?\s+\S/u;

function startsTheList(block: TextBlock): boolean {
  return block.paragraphs > 1 || LIST_ITEM.test(block.text);
}

/** A list lead-in — `ستتعلّم أن:`, `By the end, you can…` — introduces the objectives
 *  and is neither the "why" nor an objective itself. */
const LEAD_IN_END = /(:|…|\.\.\.)$/u;

function isLeadIn(block: TextBlock): boolean {
  return block.paragraphs === 1 && LEAD_IN_END.test(block.text.trim());
}

/** Where the objectives list starts: a multi-paragraph or numbered block, or — when the
 *  generator wrote one plain sentence per objective — the block right after a lead-in. */
function listStart(map: TextBlock[]): number {
  // Most specific signal first: a numbered item cannot be mistaken for anything else,
  // while a multi-paragraph block may just be a heading with its sentence.
  const numbered = map.findIndex((block) => LIST_ITEM.test(block.text));
  if (numbered !== -1) return numbered;
  const leadIn = map.findIndex(isLeadIn);
  if (leadIn !== -1 && leadIn + 1 < map.length) return leadIn + 1;
  return map.findIndex(startsTheList);
}

function isSentence(block: TextBlock): boolean {
  return block.text
    .split('\n')
    .every((line) => SENTENCE_END.test(line.trim()));
}

function scenesFor(scenes: AppScene[], key: string): AppScene[] {
  return scenes
    .filter((scene) => scene.teachingStage?.key === key)
    .sort((a, b) => a.order - b.order);
}

function joinBlocks(blocks: TextBlock[]): string {
  return blocks
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** The sentence lines of these blocks, in order. Per line rather than per block, so a
 *  heading written in the same element as its sentence (`Why it matters` / `Readers…`)
 *  drops the heading and keeps the sentence instead of losing both. */
function sentenceLines(blocks: TextBlock[]): string {
  return blocks
    .flatMap((block) => block.text.split('\n'))
    .map((line) => line.trim())
    // A letter is required: a bare `?` or `…` is a diagram label, not a sentence.
    .filter((line) => SENTENCE_END.test(line) && /\p{L}/u.test(line))
    .join('\n')
    .trim();
}

type Projector = (scenes: AppScene[]) => ApprovedIntroduction;

function projectG5V3(scenes: AppScene[]): ApprovedIntroduction {
  const opener = scenesFor(scenes, 'lesson_opener').flatMap(textBlocks);
  const map = scenesFor(scenes, 'lesson_learning_map').flatMap(textBlocks);

  const context = joinBlocks(opener.filter(isSentence));

  const listIndex = listStart(map);
  const beforeList = listIndex === -1 ? map : map.slice(0, listIndex);
  const fromList = listIndex === -1 ? [] : map.slice(listIndex);
  const whyThisLesson = sentenceLines(beforeList.filter((block) => !isLeadIn(block)));
  const overview = sentenceLines(fromList);

  return { context, whyThisLesson, overview };
}

/** `${key}@${version}` → projector. Absent means unsupported, never a default. */
const PROJECTORS: Readonly<Record<string, Projector>> = {
  'g5@g5.v3': projectG5V3,
  // g5.v4 keeps v3's `lesson_opener` and `lesson_learning_map` stages unchanged; only the
  // per-objective stages differ, and the introduction never reads them.
  'g5@g5.v4': projectG5V3,
  // g5.v5 keeps the same opener and learning-map stages (and their cover/content +
  // orientation policies); it only widens the roles allowed per objective.
  'g5@g5.v5': projectG5V3,
  // g5.v6 is g5.v5 without the final learning game (Kafuo Release 1 defers
  // generated games): the opener and learning-map stages are v5's, unchanged.
  'g5@g5.v6': projectG5V3,
};

/** Pure projection; exported for tests. Throws on an unsupported flow or a blank field. */
export function projectApprovedIntroduction(
  teachingModel: TeachingModelLineage,
  scenes: AppScene[],
): ApprovedIntroduction {
  const projector = PROJECTORS[`${teachingModel.key}@${teachingModel.version}`];
  if (!projector) {
    throw new TeachingPackageError(
      'INTRODUCTION_FLOW_UNSUPPORTED',
      `no introduction projection for teaching model ${teachingModel.key}@${teachingModel.version}`,
      { teachingModel },
    );
  }
  const introduction = projector(scenes);
  const missing = (Object.keys(introduction) as Array<keyof ApprovedIntroduction>).filter(
    (field) => introduction[field].trim() === '',
  );
  if (missing.length > 0) {
    throw new TeachingPackageError(
      'INTRODUCTION_INCOMPLETE',
      `the approved stage yields no ${missing.join(', ')} for the lesson introduction`,
      { missing },
    );
  }
  return introduction;
}

/** Read the approved version's introduction. Tenant- and item-scoped; approved only. */
export async function readApprovedIntroduction(
  pool: Queryable,
  request: ApprovedIntroductionRequest,
): Promise<ApprovedIntroductionResult> {
  const version = await readVersion(pool, request.versionId, { tenantId: request.tenantId });
  if (
    !version ||
    version.learningItem.type !== request.learningItem.type ||
    version.learningItem.id !== request.learningItem.id
  ) {
    throw new TeachingPackageError(
      'NOT_FOUND',
      `teaching package ${request.versionId} not found for this learning item`,
    );
  }
  if (version.status !== 'approved') {
    throw new TeachingPackageError(
      'TEACHING_PACKAGE_NOT_APPROVED',
      `the lesson introduction is read only from an approved teaching package, not ${version.status}`,
    );
  }
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the approved version’s stage is not live');
  }
  return {
    versionId: version.id,
    teachingModel: version.teachingModel,
    introduction: projectApprovedIntroduction(
      version.teachingModel,
      document.scenes as AppScene[],
    ),
  };
}

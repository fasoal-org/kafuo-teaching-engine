/**
 * Teaching Question role-set generation for an APPROVED Teaching Package
 * version (Kafuo question-flow closure, B1).
 *
 * TE is the question GENERATOR for TE-backed packages; Kafuo's Question Bank
 * stays the business authority (validation, review, approval, publication).
 * This service is therefore stateless: it persists no question, opens no
 * question lifecycle, and emits no webhook. It resolves everything from TE's own
 * retained Teaching Package state — never from anything Kafuo resends:
 *
 *   Learning Objective (retained attempt snapshot) → what must be assessed
 *   approved final Scenes (current Stage)          → what was actually taught
 *   retained lesson source text                    → grounds correctness
 *   Teaching Model lineage (version row)           → which flow governs
 *
 * The transient presigned `contentResource.url` is never needed: Layer A kept
 * the extracted text (`teaching_package_source_contexts`).
 */
import { parseJsonResponse } from '@openmaic/generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { readRetainedVersionContext, readVersion } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { resolveModel } from '@/lib/server/resolve-model';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  QUESTION_ENVELOPE_VERSION,
  QUESTION_GENERATION_PROMPT_VERSION,
  QUESTION_SYSTEM_PROMPT,
  TEACHING_ROLES,
  buildQuestionUserPrompt,
  type PromptSection,
  type TeachingRole,
} from '@/lib/server/teaching-package/question-generation-prompt';
import type { AppScene } from '@/lib/types/stage';
import type { LearningItemRef } from '@/lib/types/teaching-package';

const log = createLogger('TeachingPackageQuestionGeneration');

const SCENE_TEXT_MAX_CHARS = 6_000;
const SOURCE_CHUNK_TARGET_CHARS = 1_500;
const SOURCE_EXCERPT_MAX = 6;
const SOURCE_EXCERPTS_TOTAL_MAX_CHARS = 9_000;
const RESPONSE_EXCERPT_MAX_CHARS = 1_200;

export interface QuestionSetGenerationRequest {
  versionId: string;
  tenantId: string;
  learningItem: LearningItemRef;
  requestId: string;
  objectiveRef: string;
  /**
   * The Teaching Model Flow's stage scopes, unexpanded and in declaration order
   * (Kafuo owns the flow definition). TE re-expands it over the retained
   * objectives exactly as Kafuo did for generation to map `flowIndex` → scope.
   */
  flowStages: FlowStageScope[];
  language: string;
  targetRole: TeachingRole | null;
  findings: string[];
  siblingMeasurements: string[];
}

export interface FlowStageScope {
  key: string;
  scope: 'item' | 'outcome';
}

export interface ExpandedFlowEntry {
  stage: string;
  objectiveRef: string | null;
}

/**
 * The same expansion as Kafuo's `expand_teaching_model_flow`: item-scoped stages
 * once; each run of consecutive outcome-scoped stages repeated per objective, in
 * objective order, stages in declaration order inside each repetition.
 */
export function expandFlowStages(
  stages: FlowStageScope[],
  objectiveRefs: string[],
): ExpandedFlowEntry[] {
  const entries: ExpandedFlowEntry[] = [];
  let index = 0;
  while (index < stages.length) {
    if (stages[index].scope === 'item') {
      entries.push({ stage: stages[index].key, objectiveRef: null });
      index += 1;
      continue;
    }
    const run: FlowStageScope[] = [];
    while (index < stages.length && stages[index].scope === 'outcome') {
      run.push(stages[index]);
      index += 1;
    }
    for (const objectiveRef of objectiveRefs) {
      for (const stage of run) entries.push({ stage: stage.key, objectiveRef });
    }
  }
  return entries;
}

export interface QuestionSetSection {
  anchor: string;
  kind: 'teaching_scene' | 'source_excerpt';
  title: string;
  sceneId?: string;
  excerpt: string;
}

export interface QuestionSetGenerationResult {
  requestId: string;
  teachingPackageVersionId: string;
  objectiveRef: string;
  envelopeVersion: string;
  promptVersion: string;
  model: string;
  sections: QuestionSetSection[];
  envelope: Record<string, unknown>;
}

/** Test seam: the model call. Production uses `resolveModel` + `callLLM`. */
export interface QuestionModelPort {
  generate(system: string, prompt: string): Promise<{ text: string; model: string }>;
}

async function defaultModelPort(): Promise<QuestionModelPort> {
  let resolved;
  try {
    resolved = await resolveModel({ stage: 'question-generation' });
  } catch (error) {
    throw new TeachingPackageError(
      'QUESTION_GENERATION_MODEL_UNAVAILABLE',
      'no model is configured for question generation',
      { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
    );
  }
  return {
    async generate(system, prompt) {
      const result = await callLLM(
        { model: resolved.model, system, prompt },
        'question-generation',
        {
          retries: 1,
          validate: (text: string) => parseJsonResponse<Record<string, unknown>>(text) !== null,
        },
        resolved.thinkingConfig,
      );
      return { text: result.text, model: resolved.modelString };
    },
  };
}

// --------------------------------------------------------------------------
// Scene / source rendering
// --------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact, learner-visible teaching text of one Scene. No ids, no layout. */
export function renderSceneText(scene: AppScene): string {
  const parts: string[] = [];
  const content = (scene as { content?: Record<string, unknown> }).content;
  if (content?.type === 'slide') {
    const canvas = content.canvas as { elements?: Array<Record<string, unknown>> } | undefined;
    for (const element of canvas?.elements ?? []) {
      if (element.type === 'text' && typeof element.content === 'string') {
        const text = stripHtml(element.content);
        if (text) parts.push(text);
      } else if (element.type === 'shape') {
        const shapeText = (element.text as { content?: unknown } | undefined)?.content;
        if (typeof shapeText === 'string' && stripHtml(shapeText)) parts.push(stripHtml(shapeText));
      } else if (element.type === 'latex' && typeof element.latex === 'string') {
        parts.push(element.latex);
      } else if (element.type === 'table' && Array.isArray(element.data)) {
        for (const row of element.data as unknown[]) {
          if (!Array.isArray(row)) continue;
          const cells = row
            .map((cell) =>
              typeof cell === 'object' && cell !== null && typeof (cell as { text?: unknown }).text === 'string'
                ? stripHtml((cell as { text: string }).text)
                : '',
            )
            .filter(Boolean);
          if (cells.length > 0) parts.push(cells.join(' | '));
        }
      }
    }
  } else if (content?.type === 'quiz') {
    for (const question of (content.questions as Array<Record<string, unknown>>) ?? []) {
      if (typeof question.question === 'string') parts.push(`Question: ${question.question}`);
      for (const option of (question.options as Array<Record<string, unknown>>) ?? []) {
        if (typeof option.label === 'string') parts.push(`- ${option.value ?? ''} ${option.label}`);
      }
      if (typeof question.analysis === 'string') parts.push(`Explanation: ${question.analysis}`);
    }
  }
  for (const action of scene.actions ?? []) {
    const speech = action as { type?: unknown; text?: unknown };
    if (speech.type === 'speech' && typeof speech.text === 'string' && speech.text.trim()) {
      parts.push(speech.text.trim());
    }
  }
  const text = parts.join('\n');
  return text.length > SCENE_TEXT_MAX_CHARS ? text.slice(0, SCENE_TEXT_MAX_CHARS) : text;
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) out.add(match[0]);
  return out;
}

/** Bounded, deterministic source excerpts most related to the objective + taught scenes. */
export function selectSourceExcerpts(sourceText: string, focus: string): string[] {
  const paragraphs = sourceText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > SOURCE_CHUNK_TARGET_CHARS) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
    while (current.length > SOURCE_CHUNK_TARGET_CHARS * 2) {
      chunks.push(current.slice(0, SOURCE_CHUNK_TARGET_CHARS));
      current = current.slice(SOURCE_CHUNK_TARGET_CHARS);
    }
  }
  if (current) chunks.push(current);

  const focusTokens = tokens(focus);
  const scored = chunks
    .map((chunk, index) => {
      let score = 0;
      for (const token of tokens(chunk)) if (focusTokens.has(token)) score += 1;
      return { chunk, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SOURCE_EXCERPT_MAX)
    .sort((a, b) => a.index - b.index);

  const selected: string[] = [];
  let total = 0;
  for (const entry of scored) {
    if (total + entry.chunk.length > SOURCE_EXCERPTS_TOTAL_MAX_CHARS) break;
    selected.push(entry.chunk);
    total += entry.chunk.length;
  }
  return selected;
}

function normalizeEnvelope(
  parsed: Record<string, unknown>,
  objectiveRef: string,
): Record<string, unknown> {
  if (!Array.isArray(parsed.slots)) {
    throw new TeachingPackageError(
      'QUESTION_GENERATION_OUTPUT_INVALID',
      'the model output is not a teaching question role-set envelope',
    );
  }
  const echo = parsed.learning_outcome_id;
  const numericRef = /^\d+$/.test(objectiveRef) ? Number(objectiveRef) : null;
  const learningOutcomeId =
    typeof echo === 'string' && /^\d+$/.test(echo) ? Number(echo) : (echo ?? numericRef);
  return { learning_outcome_id: learningOutcomeId, slots: parsed.slots };
}

// --------------------------------------------------------------------------
// Service
// --------------------------------------------------------------------------

export async function generateTeachingQuestionSet(
  pool: Queryable,
  request: QuestionSetGenerationRequest,
  modelPort?: QuestionModelPort,
): Promise<QuestionSetGenerationResult> {
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
    // Questions are generated only from the APPROVED package. A draft, in-review,
    // rejected, superseded or discarded version is never a generation authority.
    throw new TeachingPackageError(
      'TEACHING_PACKAGE_NOT_APPROVED',
      `question generation requires an approved teaching package, not ${version.status}`,
    );
  }

  const context = await readRetainedVersionContext(pool, version.id, {
    tenantId: request.tenantId,
  });
  if (!context || context.sourceText === null) {
    throw new TeachingPackageError(
      'QUESTION_SOURCE_CONTEXT_UNAVAILABLE',
      'this approved version has no retained lesson source context (generated before retention); regenerate and approve it to enable question generation',
    );
  }
  const objective = (context.inputSnapshot.learningObjectives ?? []).find(
    (entry) => entry.objectiveRef === request.objectiveRef,
  );
  if (!objective) {
    throw new TeachingPackageError(
      'OBJECTIVE_NOT_IN_PACKAGE',
      'the learning objective is not one this teaching package was generated for',
    );
  }

  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  if (!document) {
    throw new TeachingPackageError('STAGE_NOT_LIVE', 'the approved version’s stage is not live');
  }
  // Map flow indexes to scope by re-expanding the Kafuo-owned flow over the
  // retained objectives, and refuse unless it reproduces the retained flow's
  // stage sequence exactly — a mismatch means the policy input does not describe
  // this package, and guessing a scene/objective mapping would mis-ground questions.
  const retainedObjectiveRefs = (context.inputSnapshot.learningObjectives ?? []).map(
    (entry) => entry.objectiveRef,
  );
  const expanded = expandFlowStages(request.flowStages, retainedObjectiveRefs);
  const retainedFlow = context.inputSnapshot.teachingFlow ?? [];
  if (
    expanded.length !== retainedFlow.length ||
    expanded.some((entry, i) => entry.stage !== retainedFlow[i]?.stage)
  ) {
    throw new TeachingPackageError(
      'TEACHING_MODEL_FLOW_MISMATCH',
      'the supplied flow stages do not reproduce this package’s retained teaching flow',
    );
  }
  const objectiveIndexes = new Set<number>();
  const itemIndexes = new Set<number>();
  expanded.forEach((entry, i) => {
    if (entry.objectiveRef === null) itemIndexes.add(i);
    else if (entry.objectiveRef === request.objectiveRef) objectiveIndexes.add(i);
  });
  const ordered = [...(document.scenes as AppScene[])].sort((a, b) => a.order - b.order);
  const objectiveScenes = ordered.filter(
    (scene) => scene.teachingStage && objectiveIndexes.has(scene.teachingStage.flowIndex),
  );
  if (objectiveScenes.length === 0) {
    throw new TeachingPackageError(
      'OBJECTIVE_TEACHING_MISSING',
      'the approved stage has no teaching scenes for this learning objective',
    );
  }
  const selectedScenes = ordered.filter(
    (scene) =>
      scene.teachingStage &&
      (objectiveIndexes.has(scene.teachingStage.flowIndex) ||
        itemIndexes.has(scene.teachingStage.flowIndex)),
  );

  const teachingScenes: Array<PromptSection & { sceneId: string }> = [];
  for (const scene of selectedScenes) {
    const text = renderSceneText(scene);
    if (!text) continue;
    teachingScenes.push({
      anchor: `C${teachingScenes.length + 1}`,
      title: scene.title,
      content: text,
      sceneId: scene.id,
    });
  }
  const focus = [objective.snapshot.statement, ...teachingScenes.map((s) => s.content)].join('\n');
  const sourceExcerpts: PromptSection[] = selectSourceExcerpts(context.sourceText, focus).map(
    (content, index) => ({ anchor: `S${index + 1}`, title: `Lesson source excerpt ${index + 1}`, content }),
  );

  const port = modelPort ?? (await defaultModelPort());
  const userPrompt = buildQuestionUserPrompt({
    lessonTitle: document.stage.name ?? '',
    language: request.language,
    outcomeEchoToken: request.objectiveRef,
    outcomeStatement: objective.snapshot.statement,
    teachingScenes,
    sourceExcerpts,
    targetRole: request.targetRole,
    findings: request.findings,
    siblingMeasurements: request.siblingMeasurements,
  });
  const { text, model } = await port.generate(QUESTION_SYSTEM_PROMPT, userPrompt);
  const parsed = parseJsonResponse<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new TeachingPackageError(
      'QUESTION_GENERATION_OUTPUT_INVALID',
      'the model output could not be parsed as JSON',
    );
  }
  const envelope = normalizeEnvelope(parsed, request.objectiveRef);

  log.info('teaching question set generated', {
    requestId: request.requestId,
    versionId: version.id,
    objectiveRef: request.objectiveRef,
    scenes: teachingScenes.length,
    excerpts: sourceExcerpts.length,
    targeted: request.targetRole !== null,
  });

  return {
    requestId: request.requestId,
    teachingPackageVersionId: version.id,
    objectiveRef: request.objectiveRef,
    envelopeVersion: QUESTION_ENVELOPE_VERSION,
    promptVersion: QUESTION_GENERATION_PROMPT_VERSION,
    model,
    sections: [
      ...teachingScenes.map((scene) => ({
        anchor: scene.anchor,
        kind: 'teaching_scene' as const,
        title: scene.title,
        sceneId: scene.sceneId,
        excerpt: scene.content.slice(0, RESPONSE_EXCERPT_MAX_CHARS),
      })),
      ...sourceExcerpts.map((excerpt) => ({
        anchor: excerpt.anchor,
        kind: 'source_excerpt' as const,
        title: excerpt.title,
        excerpt: excerpt.content.slice(0, RESPONSE_EXCERPT_MAX_CHARS),
      })),
    ],
    envelope,
  };
}

export function isTeachingRole(value: unknown): value is TeachingRole {
  return typeof value === 'string' && (TEACHING_ROLES as readonly string[]).includes(value);
}

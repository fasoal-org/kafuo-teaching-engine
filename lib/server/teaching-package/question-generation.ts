/**
 * Teaching Question role-set generation for an APPROVED Teaching Package
 * version (Kafuo question-flow closure, B1).
 *
 * TE is the question GENERATOR for TE-backed packages; Kafuo's Question Bank
 * stays the business authority (validation, review, approval, publication).
 * This service is therefore stateless: it persists no question, opens no
 * question lifecycle, and emits no webhook. It resolves everything from TE's own
 * retained Teaching Package state plus Kafuo's bounded approved Book Question references:
 *
 *   Learning Objective (retained attempt snapshot) → what must be assessed
 *   approved final Scenes (current Stage)          → what was actually taught
 *   retained lesson source text                    → grounds correctness
 *   approved Book Questions from Kafuo             → source assessment pattern/grounding
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
import {
  AccountingUnavailableError,
  executeTeachingCall,
  TeachingModelUnavailableError,
} from '@/lib/server/teaching-model/execute';
import { resolveSubjectModelPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { readRoutingMode } from '@/lib/server/teaching-model/subject-policy';
import { envelopeViolations } from '@/lib/server/teaching-package/question-envelope';
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
  bookQuestionReferences: BookQuestionReference[];
}

export interface BookQuestionReference {
  questionId: string;
  questionText: string;
  choices: Array<Record<string, unknown>>;
  correctAnswer: Record<string, unknown> | null;
  explanation: string | null;
  suitableRoles: TeachingRole[];
  sourcePageNumber: string | null;
  originalQuestionNumber: string | null;
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
  kind: 'teaching_scene' | 'source_excerpt' | 'book_question';
  title: string;
  sceneId?: string;
  questionId?: string;
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

/**
 * Test seam: the model call. Production uses the subject-routed teaching
 * executor (`TEACHING_SUBJECT_ROUTING=enforced`, the default) or, with
 * routing `off`, `resolveModel` + `callLLM` on the `question-generation` stage.
 *
 * `accept` says whether an output is worth returning. A port that can retry
 * retries while it answers false; one that cannot may ignore it — the caller
 * re-checks the output it is handed either way.
 */
export interface QuestionModelPort {
  generate(
    system: string,
    prompt: string,
    accept?: (text: string) => boolean,
  ): Promise<{ text: string; model: string }>;
}

/** What the routed port needs to attribute its ledger rows (contracts §1, §7). */
export interface QuestionRouteScope {
  pool: Queryable;
  tenantId: string;
  versionId: string;
  attemptId: string;
  learningItem: LearningItemRef;
  questionSetRef: string;
  /** `subjectCode` of the producing attempt's snapshot; undefined ⇒ unrouted. */
  subjectCode: string | undefined;
}

/**
 * The stage-routed port of the pre-routing era, kept verbatim for
 * `TEACHING_SUBJECT_ROUTING=off`.
 */
async function stageRoutedModelPort(): Promise<QuestionModelPort> {
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
    async generate(system, prompt, accept) {
      const result = await callLLM(
        { model: resolved.model, system, prompt },
        'question-generation',
        {
          // Two retries: envelope drift is independent per call, and a drifted
          // envelope that reaches Kafuo fails a whole generation run there, where
          // a schema mismatch is deliberately not retried.
          retries: 2,
          validate:
            accept ?? ((text: string) => parseJsonResponse<Record<string, unknown>>(text) !== null),
        },
        resolved.thinkingConfig,
      );
      return { text: result.text, model: resolved.modelString };
    },
  };
}

/**
 * The subject-routed port (Kafuo R1 plan §7.2/§7.4, ROUTE-01). The subject
 * comes from the producing attempt's retained snapshot — the version was
 * generated under that route, so its questions are too — never from the
 * request. A version whose snapshot records no subject (generated before
 * routing, or with routing off) is refused: questions for it cannot follow
 * the route, and `DEFAULT_MODEL` is never a silent substitute.
 *
 * Retry semantics: the old port's two same-model retries are REPLACED by the
 * executor's Primary → Fallback. An output `accept` refuses (unparsable, or a
 * drifted envelope Kafuo would refuse whole) is classified `unusable_output`
 * on that attempt's ledger row and the call moves to the Fallback; the same
 * on the Fallback ends the call with `TEACHING_MODEL_UNAVAILABLE`. There is
 * no same-model retry because every provider attempt must be one ledger row
 * with one outcome (plan §7.3), and a second identical request to a model
 * that just produced an unusable envelope is what the fallback is for.
 */
async function subjectRoutedModelPort(scope: QuestionRouteScope): Promise<QuestionModelPort> {
  if (!scope.subjectCode) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      'this approved version records no routed subject (generated before subject routing); regenerate and approve it to enable routed question generation',
      { versionId: scope.versionId, attemptId: scope.attemptId },
    );
  }
  const policy = await resolveSubjectModelPolicy(scope.subjectCode);
  return {
    async generate(system, prompt, accept) {
      const usable = accept ?? ((text: string) => parseJsonResponse(text) !== null);
      try {
        const result = await executeTeachingCall(
          policy,
          {
            tenantId: scope.tenantId,
            capability: 'question_generation',
            stage: 'question-generation',
            origin: 'openmaic_runtime',
            association: {
              kind: 'generation',
              generationAttemptId: scope.attemptId,
              generationRun: null,
              versionId: scope.versionId,
              learningItemType: scope.learningItem.type,
              learningItemId: scope.learningItem.id,
              questionSetRef: scope.questionSetRef,
            },
          },
          {
            system,
            prompt,
            output: {
              kind: 'json',
              validate: (text) => {
                if (!usable(text)) {
                  throw new Error('the output is not an acceptable question role-set envelope');
                }
                return parseJsonResponse<Record<string, unknown>>(text);
              },
            },
          },
          { queryable: scope.pool },
        );
        const target = result.servedBy === 'fallback' ? policy.fallback : policy.primary;
        return { text: result.text, model: target.modelString };
      } catch (error) {
        if (error instanceof TeachingModelUnavailableError) {
          throw new TeachingPackageError('TEACHING_MODEL_UNAVAILABLE', error.message, {
            subjectCode: policy.subjectCode,
            attemptIds: error.attemptIds,
            outcomes: error.outcomes,
            retryable: error.retryable,
          });
        }
        if (error instanceof AccountingUnavailableError) {
          throw new TeachingPackageError('ACCOUNTING_UNAVAILABLE', error.message);
        }
        throw error;
      }
    },
  };
}

export async function defaultModelPort(scope: QuestionRouteScope): Promise<QuestionModelPort> {
  return readRoutingMode() === 'off' ? stageRoutedModelPort() : subjectRoutedModelPort(scope);
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
              typeof cell === 'object' &&
              cell !== null &&
              typeof (cell as { text?: unknown }).text === 'string'
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
    (content, index) => ({
      anchor: `S${index + 1}`,
      title: `Lesson source excerpt ${index + 1}`,
      content,
    }),
  );
  const bookQuestions: Array<PromptSection & { questionId: string }> =
    request.bookQuestionReferences.map((question, index) => ({
      anchor: `B${index + 1}`,
      title: `Approved Book Question ${question.originalQuestionNumber ?? index + 1}`,
      questionId: question.questionId,
      content: [
        `Question: ${question.questionText}`,
        question.choices.length > 0 ? `Choices: ${JSON.stringify(question.choices)}` : '',
        question.correctAnswer ? `Approved answer: ${JSON.stringify(question.correctAnswer)}` : '',
        question.explanation ? `Approved explanation: ${question.explanation}` : '',
        `Reviewer-approved suitable roles: ${question.suitableRoles.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    }));

  const port =
    modelPort ??
    (await defaultModelPort({
      pool,
      tenantId: request.tenantId,
      versionId: version.id,
      attemptId: context.attemptId,
      learningItem: version.learningItem,
      questionSetRef: request.requestId,
      subjectCode: context.inputSnapshot.subjectCode,
    }));
  const userPrompt = buildQuestionUserPrompt({
    lessonTitle: document.stage.name ?? '',
    language: request.language,
    outcomeEchoToken: request.objectiveRef,
    outcomeStatement: objective.snapshot.statement,
    teachingScenes,
    sourceExcerpts,
    bookQuestions,
    targetRole: request.targetRole,
    findings: request.findings,
    siblingMeasurements: request.siblingMeasurements,
  });
  // The envelope's shape is only *described* to the model, and Kafuo refuses a
  // drifted one whole. Checking it here turns that drift into a retry of this
  // call instead of a failed generation run on the other side.
  const conforms = (candidate: string): boolean => {
    const json = parseJsonResponse<Record<string, unknown>>(candidate);
    if (!json || typeof json !== 'object' || !Array.isArray(json.slots)) return false;
    return envelopeViolations(normalizeEnvelope(json, request.objectiveRef)).length === 0;
  };
  const { text, model } = await port.generate(QUESTION_SYSTEM_PROMPT, userPrompt, conforms);
  const parsed = parseJsonResponse<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new TeachingPackageError(
      'QUESTION_GENERATION_OUTPUT_INVALID',
      'the model output could not be parsed as JSON',
    );
  }
  const envelope = normalizeEnvelope(parsed, request.objectiveRef);

  // Retries exhausted and still off-shape: hand it to Kafuo anyway. Kafuo is the
  // validator of record and records the refusal against its own run; failing
  // here would replace that record with an opaque TE error.
  const violations = envelopeViolations(envelope);
  if (violations.length > 0) {
    log.warn('teaching question envelope does not match the strict shape', {
      requestId: request.requestId,
      versionId: version.id,
      objectiveRef: request.objectiveRef,
      violations: violations.slice(0, 10),
    });
  }

  log.info('teaching question set generated', {
    requestId: request.requestId,
    versionId: version.id,
    objectiveRef: request.objectiveRef,
    scenes: teachingScenes.length,
    excerpts: sourceExcerpts.length,
    bookQuestions: bookQuestions.length,
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
      ...bookQuestions.map((question) => ({
        anchor: question.anchor,
        kind: 'book_question' as const,
        title: question.title,
        questionId: question.questionId,
        excerpt: question.content.slice(0, RESPONSE_EXCERPT_MAX_CHARS),
      })),
    ],
    envelope,
  };
}

export function isTeachingRole(value: unknown): value is TeachingRole {
  return typeof value === 'string' && (TEACHING_ROLES as readonly string[]).includes(value);
}

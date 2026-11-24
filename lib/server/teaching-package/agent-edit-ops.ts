/**
 * Kafuo Agent API phase 2, wave F2 (`package:write`): the agent's direct package edits
 * (plan §5 F2.1–F2.3, F2.5, with §10 overriding; F2.4 dropped).
 *
 * | op                  | what                                                         | cost |
 * |---------------------|--------------------------------------------------------------|------|
 * | `quiz-item-edit`    | stem, option texts (by current letter), key, explanation     | free |
 * | `quiz-item-delete`  | one item, with its backup; never the last                    | free |
 * | `narration-line`    | one speech line by action id, then voice the lines w/o audio | TTS  |
 * | `text-element`      | one text element's text (`text.updateContent`)               | free |
 * | `alignment-confirm` | A8: confirm a slide only this agent's ops made stale         | free |
 *
 * Every write:
 * - `expectedRevision` is the stage revision the agent read (`409 STALE_STATE`), and the
 *   scene is then written under the revision it was read at (`writeSceneAtRev`), so a
 *   write in between is `409 SCENE_REVISION_CONFLICT` and nothing lands;
 * - runs the editor's sacred-text guard on the scene it is about to write;
 * - records an agent op row ON THE WRITE'S OWN TRANSACTION (actor, result rev, result
 *   fingerprint without narration audio, "aligned before") — A8's proof — plus the
 *   `scene_changed: edited` webhook;
 * - a retry with the same `idempotencyKey` answers "done" from that row, before the
 *   revision check its write moved; another body under the key is `IDEMPOTENCY_KEY_REUSED`;
 * - `dryRun: true` runs every check and writes nothing.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { setSpeechTextClearAudioById } from '@/components/edit/ActionsBar/actions-edit';
import {
  fromRows,
  optionLetter,
  toRows,
  type OptionRow,
} from '@/components/edit/surfaces/quiz/quiz-edit-ops';
import type { AppDocument, AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { plainTextToParagraphHtml } from '@/lib/edit/slide-edit-elements';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import {
  readAllContentUnitsForVersion,
  readRetainedVersionContext,
} from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  resolveSpeechRegisterPolicy,
  validateSpeechRegister,
} from '@/lib/server/speech/register-policy';
import {
  agentAlignmentProof,
  alignedOrStaleByAgent,
  loadSceneWriteEvents,
  noAudioFingerprint,
} from '@/lib/server/teaching-package/agent-alignment-proof';
import {
  agentOpDigest,
  readAgentOpRecord,
  recordEditInTransaction,
  type AgentEditOpKind,
} from '@/lib/server/teaching-package/agent-op-records';
import { projectQuiz } from '@/lib/server/teaching-package/agent-read/scenes';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import {
  isGuideAnswerModel,
  isLearnerFirstModel,
} from '@/lib/server/teaching-package/book-coverage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  guideAnswerContextOf,
  guideAnswerGuardFor,
} from '@/lib/server/teaching-package/guide-answer-context';
import { isGuideWrittenQuestionId } from '@/lib/server/teaching-package/guide-written-attempts';
import {
  normalizeQuizPoints,
  normalizeSceneDigits,
  packageDigitStyle,
} from '@/lib/server/teaching-package/learner-first-source';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { sacredSceneEditRefusal } from '@/lib/server/teaching-package/sacred-text-edit-guard';
import { findSacredSpans, htmlToText } from '@/lib/server/teaching-package/sacred-text';
import { confirmSceneAlignments } from '@/lib/server/teaching-package/scene-alignment';
import {
  regenerateSceneNarrationAudio,
  writeSceneAtRev,
} from '@/lib/server/teaching-package/scene-narration-audio';
import {
  listRunningSceneRegenerations,
  readLiveScene,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { enqueueSceneChanged } from '@/lib/server/teaching-package/scene-webhook-events';
import { runningSceneInsertionId } from '@/lib/server/teaching-package/stage-generation-mutex';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { AppScene, QuizContent, QuizQuestion, SlideContent } from '@/lib/types/stage';
import {
  TEACHING_PACKAGE_EDITABLE_STATUSES,
  type TeachingPackageVersion,
} from '@/lib/types/teaching-package';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import { createLogger } from '@/lib/logger';

const log = createLogger('AgentEditOps');

export const AGENT_EDIT_OPS = [
  'quiz-item-edit',
  'quiz-item-delete',
  'narration-line',
  'text-element',
  'alignment-confirm',
] as const;
export type AgentEditOp = (typeof AGENT_EDIT_OPS)[number];

export interface AgentEditContext {
  pool: ConnectableQueryable;
  version: TeachingPackageVersion;
  tenantId: string;
  actorRef: string;
  dryRun: boolean;
  now?: () => number;
}

export interface AgentEditAnswer {
  status: 200;
  body: Record<string, unknown>;
}

const DRY_RUN_KEY = 'agent_dry_run';

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function invalid(field: string, rule: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_REQUEST', `${field} is ${rule}`, { field, rule });
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (value === undefined || value === null) throw invalid(field, 'required');
  if (typeof value !== 'string' || value.trim() === '') throw invalid(field, 'malformed');
  return value.trim();
}

function optionalText(body: Record<string, unknown>, field: string): string | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredText(body, field);
}

/** The Backend's engine key on a real op; absent → a fresh one (no replay possible). */
function engineKey(body: Record<string, unknown>): { key: string; given: boolean } {
  const key = body.idempotencyKey;
  if (key === undefined || key === null || key === DRY_RUN_KEY) {
    return { key: `auto_${randomUUID()}`, given: false };
  }
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw invalid('idempotencyKey', 'malformed');
  }
  return { key, given: true };
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

function assertEditable(version: TeachingPackageVersion): void {
  if (!TEACHING_PACKAGE_EDITABLE_STATUSES.includes(version.status)) {
    throw new TeachingPackageError(
      'STAGE_LOCKED',
      `the teaching package is ${version.status}; only draft or rejected packages can be edited`,
    );
  }
}

async function stageStore(actorRef: string) {
  return getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER, undefined, {
    sceneEventActorRef: actorRef,
  });
}

async function assertStageRevision(context: AgentEditContext, expected: number): Promise<void> {
  const store = await stageStore(context.actorRef);
  const manifest = await store.readFreshnessManifest(context.version.currentStageId);
  if (!manifest) throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
  const current = Number(manifest.rev);
  if (current !== expected) {
    throw new TeachingPackageError(
      'STALE_STATE',
      'the package changed since this revision was read; re-read the slides',
      { currentRevision: String(current), expectedRevision: String(expected) },
    );
  }
}

async function loadStageDocument(context: AgentEditContext): Promise<AppDocument> {
  const store = await stageStore(context.actorRef);
  const document = (await store.loadDocument(context.version.currentStageId)) as AppDocument | null;
  if (!document) throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
  return document;
}

async function assertSceneIdle(context: AgentEditContext, sceneId: string): Promise<void> {
  const now = (context.now ?? Date.now)();
  const stageId = context.version.currentStageId;
  const running = await listRunningSceneRegenerations(context.pool as never, stageId, now);
  if (running.some((entry) => entry.sceneId === sceneId)) {
    throw new TeachingPackageError(
      'SCENE_REGENERATION_IN_PROGRESS',
      'this slide is being regenerated; try again when it finishes',
    );
  }
  if (await runningSceneInsertionId(context.pool as never, stageId, now)) {
    throw new TeachingPackageError(
      'STAGE_GENERATION_IN_PROGRESS',
      'an AI slide insertion is running on this lesson; try again when it finishes',
    );
  }
}

async function assertSacredUnchanged(context: AgentEditContext, scene: AppScene): Promise<void> {
  const refusal = await sacredSceneEditRefusal(
    context.pool as never,
    context.version.currentStageId,
    scene as never,
  );
  if (refusal) {
    throw new TeachingPackageError('SACRED_TEXT_PINNED', refusal.message, {
      scenes: refusal.scenes,
    });
  }
}

/** A prior row of this key: "done" from it, or `IDEMPOTENCY_KEY_REUSED`. */
async function replayed(
  context: AgentEditContext,
  op: AgentEditOpKind | 'alignment-confirm',
  key: { key: string; given: boolean },
  digest: string,
): Promise<AgentEditAnswer | null> {
  if (context.dryRun || !key.given) return null;
  const prior = await readAgentOpRecord(context.pool as never, {
    versionId: context.version.id,
    op,
    idempotencyKey: key.key,
  });
  if (!prior) return null;
  if (prior.requestDigest !== digest) {
    throw new TeachingPackageError(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key was already used for a different request',
    );
  }
  return {
    status: 200,
    body: { dryRun: false, status: 'done', replayed: true, ...(prior.result ?? {}) },
  };
}

async function sceneRevIn(tx: Queryable, stageId: string, sceneId: string): Promise<number> {
  const revision = await tx.query<{ rev: number | string }>(
    'SELECT rev FROM document_scene_revision WHERE stage_id = $1 AND scene_id = $2',
    [stageId, sceneId],
  );
  return revision.rows[0] ? Number(revision.rows[0].rev) : 0;
}

/**
 * Write one scene under the revision it was read at, with its agent op row and webhook in
 * the same transaction. Returns the new revision and the stored result.
 */
async function writeWithRecord(
  context: AgentEditContext,
  input: {
    op: AgentEditOpKind | 'alignment-confirm';
    sceneId: string;
    baseRev: number;
    scene: AppScene;
    key: string;
    digest: string;
    alignedBefore: boolean;
    result: Record<string, unknown>;
  },
): Promise<{ rev: number; result: Record<string, unknown> }> {
  const clock = context.now ?? Date.now;
  const stageId = context.version.currentStageId;
  let stored: Record<string, unknown> = input.result;
  const rev = await writeSceneAtRev(
    context.pool,
    { stageId, sceneId: input.sceneId, baseRev: input.baseRev },
    input.scene,
    async (tx) => {
      const resultSceneRev = await sceneRevIn(tx, stageId, input.sceneId);
      stored = { ...input.result, sceneId: input.sceneId, resultSceneRev };
      await recordEditInTransaction(tx, {
        tenantId: context.tenantId,
        versionId: context.version.id,
        idempotencyKey: input.key,
        sceneId: input.sceneId,
        requestDigest: input.digest,
        now: clock(),
        op: input.op,
        actorRef: context.actorRef,
        resultSceneRev,
        resultFingerprint: noAudioFingerprint(input.scene),
        alignedBefore: input.alignedBefore,
        result: stored,
      });
      await enqueueSceneChanged(tx, {
        versionId: context.version.id,
        stageId,
        sceneId: input.sceneId,
        change: 'edited',
        actorRef: context.actorRef,
      });
    },
  );
  return { rev, result: { ...stored, resultSceneRev: rev } };
}

interface EditPlan {
  op: AgentEditOpKind;
  sceneId: string;
  body: Record<string, unknown>;
  /** The digest of the agent's own request fields (the replay check). */
  digest: string;
  build: (
    live: AppScene,
    document: AppDocument,
  ) => Promise<{ next: AppScene; result: Record<string, unknown> }>;
}

/** The common path of the four content edits. */
async function runSceneEdit(
  context: AgentEditContext,
  expectedRevision: number,
  plan: EditPlan,
): Promise<AgentEditAnswer & { written: boolean }> {
  const key = engineKey(plan.body);
  const replay = await replayed(context, plan.op, key, plan.digest);
  if (replay) return { ...replay, written: false };
  await assertStageRevision(context, expectedRevision);
  assertEditable(context.version);
  await assertSceneIdle(context, plan.sceneId);
  const stageId = context.version.currentStageId;
  const live = await readLiveScene(context.pool as never, stageId, plan.sceneId);
  if (!live)
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide is not part of this stage');
  const document = await loadStageDocument(context);
  const built = await plan.build(structuredClone(live.scene), document);
  const next = { ...built.next, updatedAt: (context.now ?? Date.now)() } as AppScene;
  await assertSacredUnchanged(context, next);
  const events = await loadSceneWriteEvents(context.pool as never, context.version.id, stageId, [
    plan.sceneId,
  ]);
  const alignedBefore = alignedOrStaleByAgent(live.scene, events.get(plan.sceneId) ?? []);
  if (context.dryRun) {
    return {
      status: 200,
      written: false,
      body: { dryRun: true, status: 'would_update', sceneId: plan.sceneId, ...built.result },
    };
  }
  const written = await writeWithRecord(context, {
    op: plan.op,
    sceneId: plan.sceneId,
    baseRev: live.rev,
    scene: next,
    key: key.key,
    digest: plan.digest,
    alignedBefore,
    result: built.result,
  });
  return {
    status: 200,
    written: true,
    body: { dryRun: false, status: 'done', replayed: false, ...written.result },
  };
}

// ---------------------------------------------------------------------------
// F2.1 quiz items
// ---------------------------------------------------------------------------

function quizQuestions(scene: AppScene): QuizQuestion[] {
  return ((scene.content as QuizContent).questions ?? []) as QuizQuestion[];
}

function quizItemOf(scene: AppScene, itemId: string): QuizQuestion {
  if (scene.type !== 'quiz') {
    throw new TeachingPackageError(
      'SCENE_TYPE_NOT_EDITABLE',
      `quiz items live on quiz scenes; this scene is a ${scene.type}`,
    );
  }
  if (isBankQuizScene(scene as never)) {
    throw new TeachingPackageError(
      'BANK_QUIZ_NOT_EDITABLE',
      'this quiz shows the approved question-bank questions; they are edited in Kafuo',
    );
  }
  const question = quizQuestions(scene).find((candidate) => candidate.id === itemId);
  if (!question) {
    throw new TeachingPackageError(
      'QUIZ_ITEM_NOT_FOUND',
      'no quiz item with that id on the slide',
      {
        itemId,
      },
    );
  }
  if (isGuideWrittenQuestionId(question.id)) {
    // D-8: rebuilt from the teacher guide on every regeneration; grading needs it.
    throw new TeachingPackageError(
      'ENGINE_QUESTION_NOT_EDITABLE',
      'this question is written by the engine from the teacher guide; fix it in the guide or ask a person',
      { itemId },
    );
  }
  assertNoSacredItem(question);
  return question;
}

/**
 * The exercise rule (owner, 4 Nov 2026): a Quran verse or hadith item is never edited or
 * removed by the agent; it is left to a person. Conservative: any verse or hadith span in
 * the stem, an option or the explanation.
 */
function assertNoSacredItem(question: QuizQuestion): void {
  const texts = [
    question.question,
    question.analysis,
    ...(question.options ?? []).map((option) => option.label),
  ].filter((value): value is string => typeof value === 'string');
  if (texts.some((value) => findSacredSpans(htmlToText(value)).spans.length > 0)) {
    throw new TeachingPackageError(
      'SACRED_EXERCISE_ITEM',
      'this quiz item shows a Quran verse or hadith; it is left to a person',
      { itemId: question.id },
    );
  }
}

function withQuestion(scene: AppScene, question: QuizQuestion): AppScene {
  const content = scene.content as QuizContent;
  return {
    ...scene,
    content: {
      ...content,
      questions: content.questions.map((q) => (q.id === question.id ? question : q)),
    },
  } as AppScene;
}

/** Regeneration's W5 normalization (digits, points) on learner-first packages only. */
function learnerFirstNormalized(
  context: AgentEditContext,
  scene: AppScene,
  document: AppDocument,
): AppScene {
  if (!isLearnerFirstModel(context.version.teachingModel)) return scene;
  const others = document.scenes.filter((candidate) => candidate.id !== scene.id);
  const style = packageDigitStyle(others as never, document.stage.language);
  const copy = structuredClone(scene);
  normalizeSceneDigits(copy as never, style);
  normalizeQuizPoints(copy as never);
  return copy;
}

interface OptionEdit {
  id: string;
  text: string;
}

function optionEdits(value: unknown): OptionEdit[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalid('options', 'malformed');
  return value.map((entry) => {
    const record = entry as { id?: unknown; text?: unknown } | null;
    if (
      !record ||
      typeof record.id !== 'string' ||
      record.id === '' ||
      typeof record.text !== 'string' ||
      record.text.trim() === ''
    ) {
      throw invalid('options', 'malformed');
    }
    return { id: record.id, text: record.text.trim() };
  });
}

function idList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
    throw invalid(field, 'malformed');
  }
  return [...new Set(value as string[])];
}

/** The edited item and the letters its options carry now (`fromRows` re-letters). */
export function editQuizItem(
  question: QuizQuestion,
  edit: {
    stem?: string;
    explanation?: string;
    options?: OptionEdit[];
    correctOptionIds?: string[];
    correctValue?: string;
  },
): { question: QuizQuestion; optionLetters: Array<{ from: string; to: string }> } {
  let next: QuizQuestion = { ...question };
  if (edit.stem !== undefined) next.question = edit.stem;
  if (edit.explanation !== undefined) next.analysis = edit.explanation;
  const choice = question.type === 'single' || question.type === 'multiple';
  if (!choice) {
    if (edit.options || edit.correctOptionIds) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'a short-answer item has no options; set correctValue',
        { field: edit.options ? 'options' : 'correctOptionIds', rule: 'not_applicable' },
      );
    }
    if (edit.correctValue !== undefined) next.answer = [edit.correctValue];
    return { question: next, optionLetters: [] };
  }
  if (edit.correctValue !== undefined) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'a choice item is keyed by correctOptionIds, not correctValue',
      { field: 'correctValue', rule: 'not_applicable' },
    );
  }
  const options = question.options ?? [];
  const indexOf = new Map(options.map((option, index) => [option.value, index]));
  const rows: OptionRow[] = toRows(question);
  for (const option of edit.options ?? []) {
    const index = indexOf.get(option.id);
    if (index === undefined) {
      throw new TeachingPackageError(
        'QUIZ_OPTION_NOT_FOUND',
        `the item has no option ${JSON.stringify(option.id)}`,
        { optionId: option.id, optionIds: options.map((o) => o.value) },
      );
    }
    rows[index] = { ...rows[index]!, label: option.text };
  }
  if (edit.correctOptionIds) {
    const missing = edit.correctOptionIds.filter((id) => !indexOf.has(id));
    if (missing.length > 0 || edit.correctOptionIds.length === 0) {
      throw new TeachingPackageError(
        'QUIZ_KEY_NOT_IN_OPTIONS',
        missing.length > 0
          ? 'a correct option is not among the item’s options'
          : 'the item needs at least one correct option',
        { missing, optionIds: options.map((o) => o.value) },
      );
    }
    const correct = new Set(edit.correctOptionIds.map((id) => indexOf.get(id)!));
    rows.forEach((row, index) => (row.correct = correct.has(index)));
  }
  const keyed = rows.filter((row) => row.correct).length;
  if (question.type === 'single' && keyed !== 1) {
    throw new TeachingPackageError(
      'QUIZ_SINGLE_KEY_COUNT',
      'a single-choice item needs exactly one correct option',
      { correct: keyed },
    );
  }
  if (keyed === 0) {
    throw new TeachingPackageError(
      'QUIZ_KEY_NOT_IN_OPTIONS',
      'the item needs at least one correct option',
      { missing: [], optionIds: options.map((o) => o.value) },
    );
  }
  next = { ...next, ...fromRows(rows) };
  return {
    question: next,
    optionLetters: options.map((option, index) => ({
      from: option.value,
      to: optionLetter(index),
    })),
  };
}

function projectedItem(scene: AppScene, itemId: string) {
  return projectQuiz(scene)?.items?.find((item) => item.id === itemId) ?? null;
}

async function quizItemEditOp(
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
) {
  const sceneId = requiredText(body, 'sceneId');
  const itemId = requiredText(body, 'itemId');
  const edit = {
    stem: optionalText(body, 'stem'),
    explanation: optionalText(body, 'explanation'),
    options: optionEdits(body.options),
    correctOptionIds: idList(body.correctOptionIds, 'correctOptionIds'),
    correctValue: optionalText(body, 'correctValue'),
  };
  if (Object.values(edit).every((value) => value === undefined)) {
    throw invalid('stem|options|correctOptionIds|correctValue|explanation', 'required');
  }
  return runSceneEdit(context, expectedRevision, {
    op: 'quiz-item-edit',
    sceneId,
    body,
    digest: agentOpDigest({ op: 'quiz-item-edit', sceneId, itemId, edit }),
    build: async (live, document) => {
      const question = quizItemOf(live, itemId);
      const edited = editQuizItem(question, edit);
      assertNoSacredItem(edited.question);
      const next = learnerFirstNormalized(context, withQuestion(live, edited.question), document);
      return {
        next,
        result: {
          itemId,
          optionLetters: edited.optionLetters,
          item: projectedItem(next, itemId),
        },
      };
    },
  });
}

async function quizItemDeleteOp(
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
) {
  const sceneId = requiredText(body, 'sceneId');
  const itemId = requiredText(body, 'itemId');
  const reason = requiredText(body, 'reason');
  return runSceneEdit(context, expectedRevision, {
    op: 'quiz-item-delete',
    sceneId,
    body,
    digest: agentOpDigest({ op: 'quiz-item-delete', sceneId, itemId, reason }),
    build: async (live) => {
      const question = quizItemOf(live, itemId);
      const questions = quizQuestions(live);
      if (questions.length <= 1) {
        throw new TeachingPackageError(
          'QUIZ_LAST_ITEM',
          'this is the quiz’s only item; it cannot be deleted',
          { itemId },
        );
      }
      const index = questions.findIndex((q) => q.id === itemId);
      const next = {
        ...live,
        content: {
          ...(live.content as QuizContent),
          questions: questions.filter((q) => q.id !== itemId),
        },
      } as AppScene;
      return {
        next,
        result: {
          itemId,
          reason,
          deleted: true,
          backup: {
            scene_id: live.id,
            position: index + 1,
            item: projectedItem(live, itemId),
            question,
          },
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// F2.2 narration line (by action id)
// ---------------------------------------------------------------------------

function spokenTexts(actions: readonly Action[] | undefined): string[] {
  return (actions ?? []).flatMap((action) =>
    action.type === 'speech' && typeof (action as { text?: unknown }).text === 'string'
      ? [(action as { text: string }).text]
      : [],
  );
}

/** The register check generated lines get (no re-roll here: a failure refuses the edit). */
async function assertRegister(
  context: AgentEditContext,
  document: AppDocument,
  before: AppScene,
  after: AppScene,
  newText: string,
): Promise<void> {
  const retained = await readRetainedVersionContext(context.pool as never, context.version.id, {
    tenantId: context.tenantId,
  });
  const subjectCode =
    (retained?.inputSnapshot as { subjectCode?: string } | undefined)?.subjectCode ?? null;
  const policy = resolveSpeechRegisterPolicy({ language: document.stage.language, subjectCode });
  if (!policy) return;
  const had = new Set(
    validateSpeechRegister(spokenTexts(before.actions), policy).map((i) => i.code),
  );
  const issues = [
    ...validateSpeechRegister([newText], policy),
    ...validateSpeechRegister(spokenTexts(after.actions), policy).filter((i) => !had.has(i.code)),
  ];
  if (issues.length > 0) {
    throw new TeachingPackageError(
      'SPEECH_REGISTER_NONCOMPLIANT',
      `the new line breaks the ${policy.register} narration policy (${[
        ...new Set(issues.map((issue) => issue.code)),
      ].join(', ')})`,
      {
        policyVersion: policy.version,
        register: policy.register,
        issues: issues.map((issue) => ({ code: issue.code, evidence: issue.evidence })),
      },
    );
  }
}

/** g5.v11: the guide-answer leak check generated lines get, on this slide's plan. */
async function assertNoGuideLeak(
  context: AgentEditContext,
  document: AppDocument,
  before: AppScene,
  after: AppScene,
): Promise<void> {
  if (!isGuideAnswerModel(context.version.teachingModel)) return;
  const retained = await readRetainedVersionContext(context.pool as never, context.version.id, {
    tenantId: context.tenantId,
  });
  if (!retained) return;
  const units = (
    await readAllContentUnitsForVersion(context.pool as never, context.version.id, {
      tenantId: context.tenantId,
    })
  ).units;
  const guideContext = guideAnswerContextOf({
    teachingModel: context.version.teachingModel,
    snapshot: retained.inputSnapshot as never,
    units: units as never,
    language: document.stage.language,
  });
  if (!guideContext) return;
  const outlines = ((document.outline as AppDocumentOutline | null)?.outlines ??
    []) as unknown as SceneOutline[];
  const outline = outlines.find((entry) => entry.id === after.outlineId);
  if (!outline) return;
  const guard = guideAnswerGuardFor(guideContext, outlines);
  if (!guard.planOf(outline.id)) return;
  const had = guard.checkNarration(outline, (before.actions ?? []) as never).length;
  const leaks = guard.checkNarration(outline, (after.actions ?? []) as never);
  if (leaks.length > had) {
    throw new TeachingPackageError(
      'GUIDE_ANSWER_LEAK',
      'the new line states a checked answer before the learner’s try',
      { findings: leaks.map((finding) => finding.code) },
    );
  }
}

async function narrationLineOp(
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
) {
  const sceneId = requiredText(body, 'sceneId');
  const actionId = requiredText(body, 'actionId');
  // Never pre-normalized (§10): the reading mode is applied at synthesis.
  const newText = requiredText(body, 'text');
  const answer = await runSceneEdit(context, expectedRevision, {
    op: 'narration-line',
    sceneId,
    body,
    digest: agentOpDigest({ op: 'narration-line', sceneId, actionId, text: newText }),
    build: async (live, document) => {
      const action = (live.actions ?? []).find((candidate) => candidate.id === actionId);
      if (!action || action.type !== 'speech') {
        throw new TeachingPackageError(
          'NARRATION_LINE_NOT_FOUND',
          'no narration line with that action id on the slide',
          { actionId },
        );
      }
      const next = {
        ...live,
        actions: setSpeechTextClearAudioById((live.actions ?? []) as Action[], actionId, newText),
      } as AppScene;
      await assertRegister(context, document, live, next, newText);
      await assertNoGuideLeak(context, document, live, next);
      return { next, result: { actionId, text: newText } };
    },
  });
  if (!answer.written) return answer;
  // The text landed; now voice the lines without audio (that line), with the Stage's own
  // TTS route. A failure here never undoes the text: the line reads `missing` and the
  // agent may call `narration-audio`.
  let audio: Record<string, unknown>;
  try {
    const result = await regenerateSceneNarrationAudio(
      {
        tenantId: context.tenantId,
        versionId: context.version.id,
        stageId: context.version.currentStageId,
        learnerKey: context.actorRef,
      } as never,
      sceneId,
      {
        pool: context.pool,
        actorRef: context.actorRef,
        ...(context.now ? { now: context.now } : {}),
      },
    );
    audio = {
      status: 'done',
      rev: result.rev,
      generated: result.generated,
      missing: result.missing,
    };
  } catch (error) {
    const code = error instanceof TeachingPackageError ? error.code : 'INTERNAL_ERROR';
    log.warn(`narration line audio for scene ${sceneId} ended with ${code}`);
    audio = { status: 'failed', errorCode: code };
  }
  return { ...answer, body: { ...answer.body, audio } };
}

// ---------------------------------------------------------------------------
// F2.3 one text element
// ---------------------------------------------------------------------------

async function textElementOp(
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
) {
  const sceneId = requiredText(body, 'sceneId');
  const elementId = requiredText(body, 'elementId');
  const newText = requiredText(body, 'text');
  return runSceneEdit(context, expectedRevision, {
    op: 'text-element',
    sceneId,
    body,
    digest: agentOpDigest({ op: 'text-element', sceneId, elementId, text: newText }),
    build: async (live) => {
      if (live.type !== 'slide') {
        throw new TeachingPackageError(
          'SCENE_TYPE_NOT_EDITABLE',
          `text elements live on slides; this scene is a ${live.type}`,
        );
      }
      const content = live.content as SlideContent;
      const element = content.canvas.elements.find((candidate) => candidate.id === elementId);
      if (!element) {
        throw new TeachingPackageError(
          'ELEMENT_NOT_FOUND',
          'no element with that id on the slide',
          {
            elementId,
          },
        );
      }
      if (element.type !== 'text') {
        throw new TeachingPackageError(
          'ELEMENT_NOT_TEXT',
          `only text elements can be edited this way; this element is a ${element.type}`,
          { elementId, type: element.type },
        );
      }
      const nextContent = applySlideEditOperation(content, {
        type: 'text.updateContent',
        elementId,
        content: plainTextToParagraphHtml(newText),
      });
      return {
        next: { ...live, content: nextContent } as AppScene,
        result: { elementId, text: newText },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// F2.5 alignment confirmation (A8)
// ---------------------------------------------------------------------------

async function alignmentConfirmOp(
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentEditAnswer> {
  const sceneId = requiredText(body, 'sceneId');
  const reason = requiredText(body, 'reason');
  const key = engineKey(body);
  const digest = agentOpDigest({ op: 'alignment-confirm', sceneId, reason });
  const replay = await replayed(context, 'alignment-confirm', key, digest);
  if (replay) return replay;
  await assertStageRevision(context, expectedRevision);
  assertEditable(context.version);
  await assertSceneIdle(context, sceneId);
  const stageId = context.version.currentStageId;
  // The revision first, then the document: a write in between fails the write's fence.
  const live = await readLiveScene(context.pool as never, stageId, sceneId);
  if (!live)
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide is not part of this stage');
  const document = await loadStageDocument(context);
  const scene = document.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene)
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide is not part of this stage');
  const alignment = deriveSceneAlignment(scene);
  if (alignment.aligned) {
    return {
      status: 200,
      body: {
        dryRun: context.dryRun,
        status: 'done',
        alreadyAligned: true,
        sceneId,
        alignment: { state: alignment.state },
      },
    };
  }
  const events = await loadSceneWriteEvents(context.pool as never, context.version.id, stageId, [
    sceneId,
  ]);
  const proof = agentAlignmentProof(scene, events.get(sceneId) ?? []);
  if (!proof.ok) {
    throw new TeachingPackageError(
      'STALE_NOT_BY_AGENT',
      'this slide was not made stale by the agent’s own op alone; it stays with the teacher',
      { sceneId, reason: proof.reason, alignmentReason: alignment.reason ?? null },
    );
  }
  if (context.dryRun) {
    return {
      status: 200,
      body: { dryRun: true, status: 'would_confirm', sceneId, proof: proof.event.kind },
    };
  }
  let written: { rev: number; result: Record<string, unknown> } | null = null;
  await confirmSceneAlignments(
    context.pool,
    context.version.id,
    { tenantId: context.tenantId, actorRef: context.actorRef },
    [{ sceneId }],
    (context.now ?? Date.now)(),
    {
      document,
      putScene: async (_stage, updated) => {
        written = await writeWithRecord(context, {
          op: 'alignment-confirm',
          sceneId,
          baseRev: live.rev,
          scene: updated,
          key: key.key,
          digest,
          alignedBefore: false,
          result: { reason, proof: proof.event.kind, alignment: { state: 'confirmed' } },
        });
      },
    },
  );
  return {
    status: 200,
    body: {
      dryRun: false,
      status: 'done',
      replayed: false,
      ...(written as { result: Record<string, unknown> } | null)?.result,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function isAgentEditOp(op: string): op is AgentEditOp {
  return (AGENT_EDIT_OPS as readonly string[]).includes(op);
}

export async function runAgentEditOp(
  op: AgentEditOp,
  context: AgentEditContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentEditAnswer> {
  switch (op) {
    case 'quiz-item-edit':
      return strip(await quizItemEditOp(context, body, expectedRevision));
    case 'quiz-item-delete':
      return strip(await quizItemDeleteOp(context, body, expectedRevision));
    case 'narration-line':
      return strip(await narrationLineOp(context, body, expectedRevision));
    case 'text-element':
      return strip(await textElementOp(context, body, expectedRevision));
    case 'alignment-confirm':
      return alignmentConfirmOp(context, body, expectedRevision);
  }
}

function strip(answer: AgentEditAnswer & { written?: boolean }): AgentEditAnswer {
  return { status: answer.status, body: answer.body };
}

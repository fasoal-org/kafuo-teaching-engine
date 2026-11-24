/**
 * Kafuo Agent API wave E3 (`package:write`): the agent's teaching-package editor
 * writes (agent API plan §1.5, §8 E3; owner decision D-6).
 *
 * Every op runs the SAME service the editor's own route calls, with the actor
 * `agent:<user id>` instead of the editor grant's, and the Backend's
 * idempotency key passed to the service's own `idempotencyKey`:
 *
 * | op               | service                                                    | model |
 * |------------------|------------------------------------------------------------|-------|
 * | `regenerate`     | `regenerateSlideScene`                                     | yes   |
 * | `generate`       | `insertGeneratedSlide`                                     | yes   |
 * | `link`           | `regenerateSlideScene` + `contentUnitChange: add` (D-6)    | yes   |
 * | `narration-audio`| `regenerateSceneNarrationAudio`                            | TTS   |
 * | `delete`         | `deleteDuplicateScene` (new, guarded, returns the backup)  | no    |
 * | `skills`         | `setSceneTeachingSkills` (the scene-skills service)        | no    |
 * | `add-image`      | `regenerateSlideScene` + `imageAddition` (phase 2 F3.3)    | yes   |
 * | `quiz-item-edit`, `quiz-item-delete`, `narration-line` (TTS), `text-element`,      |
 * |   `alignment-confirm` — phase 2 wave F2, `agent-edit-ops.ts`              | no    |
 *
 * Common rules:
 * - `expectedRevision` is the stage revision the agent read (`agent-read/scenes`
 *   `revision`); another one is `409 STALE_STATE` before anything runs. A request
 *   whose idempotency key already names a run is answered from that run first
 *   (the stage has moved since, by that very run).
 * - `dryRun: true` runs every check the op can make without a model or a write:
 *   no model route is resolved (that is where the meter starts), no package,
 *   regeneration or insertion row is written, nothing is saved. The one record a
 *   dry run writes is a link's D-6 proof (below).
 * - The AI ops answer `202 { opId, status: 'running' }` once their run row exists
 *   (the service's T1), or the service's own result or refusal if it settles
 *   first. The run continues under `after()`; `GET agent-ops/ops/{opId}` reads it
 *   exactly as the editor's own status GET does (the same reader, which settles an
 *   expired lease the same way). `opId` = `rg_<key>` (a regeneration) or `in_<key>`
 *   (an insertion).
 * - Retries by key (the Backend's namespaced engine key): a regeneration or an
 *   insertion is answered from its run row; generate compares the agent's own
 *   fields with that row (`IDEMPOTENCY_KEY_REUSED` on a mismatch); a delete, from
 *   the record written in its own transaction (done + the backup); narration audio,
 *   from its leased marker (`AGENT_OP_IN_PROGRESS` while a slow TTS run holds it,
 *   then done) — never a second synthesis; a skill, from the slide itself (it
 *   already carries that primary: "already applied"). All before the revision check.
 * - D-6 "dry run first": a real `link` needs a successful link dry run by the same
 *   key on the same slide and part within 30 minutes (`409 LINK_DRY_RUN_REQUIRED`).
 * - Never offered (no op): submit, approve, reject, publish, «Regenerate all
 *   voiceover», rebuild, new version, discard, «Move and rewrite both slides»,
 *   the stage-wide skill → `422 AGENT_ACTION_NOT_ALLOWED`.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppDocument, AppDocumentOutline } from '@/lib/document-store/persistence-types';
import {
  readAllContentUnitsForVersion,
  readRetainedVersionContext,
} from '@/lib/persistence/teaching-package';
import { isBookPartPlacementModel } from '@/lib/server/teaching-package/book-coverage';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { isBankQuizScene } from '@/lib/server/teaching-package/bank-quiz-scene';
import {
  allowedStagesAt,
  orderedScenes,
  placeholderProjection,
  resolveInsertionPosition,
} from '@/lib/server/teaching-package/content-unit-coverage';
import {
  agentOpDigest,
  claimNarration,
  completeNarration,
  LINK_DRY_RUN_WINDOW_MS,
  readAgentOpRecord,
  recordLinkDryRun,
  releaseNarration,
  type AgentOpRecord,
} from '@/lib/server/teaching-package/agent-op-records';
import {
  deleteDuplicateScene,
  replayDuplicateDelete,
  type DuplicateDeleteResult,
} from '@/lib/server/teaching-package/delete-duplicate-scene';
import { AGENT_EDIT_OPS, runAgentEditOp } from '@/lib/server/teaching-package/agent-edit-ops';
import {
  checkSlideImageAddition,
  SLIDE_IMAGE_NOTE_MAX,
} from '@/lib/server/teaching-package/add-slide-image';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { resolveGovernedRegenerationContext } from '@/lib/server/teaching-package/governed-regeneration';
import {
  insertionSkillsInvalidError,
  preCheckExistingSceneSkills,
} from '@/lib/server/teaching-package/insertion-skill-validation';
import { narrationAudioGap } from '@/lib/server/teaching-package/narration-audio-issue';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { planInsertedSlide } from '@/lib/server/teaching-package/plan-inserted-slide';
import { replanMovedSlide } from '@/lib/server/teaching-package/replan-moved-slide';
import {
  checkPositionAndUnits,
  exactFlowOrRefuse,
  insertGeneratedSlide,
  parseSceneInsertionRequest,
  readInsertionContext,
  readSceneInsertionForGrant,
  SCENE_INSERTION_MAX_ADMISSION_WINDOW_MS,
  type SceneInsertionRequest,
} from '@/lib/server/teaching-package/scene-insertion';
import {
  listRunningSceneInsertions,
  readSceneInsertionByKey,
  type SceneInsertion,
} from '@/lib/server/teaching-package/scene-insertion-store';
import { regenerateSceneNarrationAudio } from '@/lib/server/teaching-package/scene-narration-audio';
import {
  bookPartBlocksFor,
  parseSceneRegenerationRequest,
  readSceneRegenerationForGrant,
  regenerateSlideScene,
  resolveContentUnitChange,
  sceneRegenerationRequestDigest,
  type SceneRegenerationRequest,
} from '@/lib/server/teaching-package/scene-regeneration';
import {
  listRunningSceneRegenerations,
  readLiveScene,
  readSceneRegenerationByKey,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import {
  normalizeSkillAssignment,
  setSceneTeachingSkills,
} from '@/lib/server/teaching-package/scene-skills';
import { runningSceneInsertionId } from '@/lib/server/teaching-package/stage-generation-mutex';
import {
  TEACHING_PACKAGE_EDITABLE_STATUSES,
  type SceneTeachingSkills,
  type TeachingPackageVersion,
} from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('AgentOps');

export const AGENT_OPS = [
  'regenerate',
  'generate',
  'link',
  'narration-audio',
  'delete',
  'skills',
  // Phase 2 F3.3: add an eligible textbook image (a regeneration-type op).
  'add-image',
  // Phase 2 wave F2 (agent-edit-ops.ts): direct edits and the A8 confirmation.
  ...AGENT_EDIT_OPS,
] as const;
export type AgentOp = (typeof AGENT_OPS)[number];

/** What the agent is never offered, under the names a client may use (plan §8 E3). */
export const AGENT_NEVER_OFFERED_OPS: readonly string[] = [
  'submit',
  'send-for-approval',
  'approve',
  'reject',
  'publish',
  'unpublish',
  'regenerate-all-voiceover',
  'regenerate-all-audio',
  'rebuild',
  'new-version',
  'successor',
  'discard',
  'move-part',
  'move-and-rewrite',
  'stage-skills',
  'teaching-stage-skills',
];

const AGENT_ACTOR = /^agent:[1-9][0-9]{0,18}$/;
const REGENERATION_OP_PREFIX = 'rg_';
const INSERTION_OP_PREFIX = 'in_';
/** The placeholder key of a dry run (never stored: a dry run writes no row). */
const DRY_RUN_KEY = 'agent_dry_run';

export function isAgentOp(value: string): value is AgentOp {
  return (AGENT_OPS as readonly string[]).includes(value);
}

export function assertAgentOpOffered(op: string): AgentOp | null {
  if (AGENT_NEVER_OFFERED_OPS.includes(op)) {
    throw new TeachingPackageError(
      'AGENT_ACTION_NOT_ALLOWED',
      'the agent is never offered this action',
      { op },
    );
  }
  return isAgentOp(op) ? op : null;
}

function invalid(field: string, rule: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_REQUEST', `${field} is ${rule}`, { field, rule });
}

export function assertAgentOpsActor(actorRef: unknown): string {
  if (typeof actorRef !== 'string' || !AGENT_ACTOR.test(actorRef)) {
    throw new TeachingPackageError(
      'AGENT_ACTION_NOT_ALLOWED',
      'the agent editor routes take only an agent:<user id> actor',
    );
  }
  return actorRef;
}

export function parseAgentDryRun(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalid('dryRun', 'malformed');
  return value;
}

/** The stage revision the agent read: a non-negative integer, as a number or a string. */
export function parseExpectedRevision(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,15}$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalid('expectedRevision', 'required');
  }
  return parsed;
}

function text(body: Record<string, unknown>, field: string, required = true): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw invalid(field, 'required');
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') throw invalid(field, 'malformed');
  return value.trim();
}

export function regenerationOpId(idempotencyKey: string): string {
  return `${REGENERATION_OP_PREFIX}${idempotencyKey}`;
}

export function insertionOpId(idempotencyKey: string): string {
  return `${INSERTION_OP_PREFIX}${idempotencyKey}`;
}

export function parseOpId(opId: string): { kind: 'regeneration' | 'insertion'; key: string } {
  if (opId.startsWith(REGENERATION_OP_PREFIX) && opId.length > REGENERATION_OP_PREFIX.length) {
    return { kind: 'regeneration', key: opId.slice(REGENERATION_OP_PREFIX.length) };
  }
  if (opId.startsWith(INSERTION_OP_PREFIX) && opId.length > INSERTION_OP_PREFIX.length) {
    return { kind: 'insertion', key: opId.slice(INSERTION_OP_PREFIX.length) };
  }
  throw new TeachingPackageError('NOT_FOUND', 'no such op');
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AgentOpsContext {
  pool: ConnectableQueryable;
  version: TeachingPackageVersion;
  tenantId: string;
  actorRef: string;
  dryRun: boolean;
  /** Keep a run alive after the response (Next.js `after`). */
  after: (task: () => Promise<unknown>) => void;
  now?: () => number;
}

interface Grant {
  tenantId: string;
  versionId: string;
  stageId: string;
  learnerKey: string;
}

function grantOf(context: AgentOpsContext): Grant {
  return {
    tenantId: context.tenantId,
    versionId: context.version.id,
    stageId: context.version.currentStageId,
    // Never a learner: the session ref is the agent's own (null) through `actor`.
    learnerKey: context.actorRef,
  };
}

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

async function readStageRevision(context: AgentOpsContext): Promise<number> {
  const store = await stageStore(context.actorRef);
  const manifest = await store.readFreshnessManifest(context.version.currentStageId);
  if (!manifest) throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
  return Number(manifest.rev);
}

/** `409 STALE_STATE` unless the stage is still at the revision the agent read. */
export async function assertStageRevision(context: AgentOpsContext, expected: number) {
  const current = await readStageRevision(context);
  if (current !== expected) {
    throw new TeachingPackageError(
      'STALE_STATE',
      'the package changed since this revision was read; re-read the slides',
      { currentRevision: String(current), expectedRevision: String(expected) },
    );
  }
  return current;
}

async function loadStageDocument(context: AgentOpsContext): Promise<AppDocument> {
  const store = await stageStore(context.actorRef);
  const document = (await store.loadDocument(context.version.currentStageId)) as AppDocument | null;
  if (!document) throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
  return document;
}

// ---------------------------------------------------------------------------
// The async runner
// ---------------------------------------------------------------------------

type Started<T> = { kind: 'settled'; value: T } | { kind: 'started' };

/**
 * Start a run and answer as soon as its row exists (`onStarted`, fired by the
 * first model-path seam after T1) or the service settles, whichever is first.
 * The run itself is handed to `after()` so it outlives the response.
 */
export async function runUntilStarted<T>(
  context: Pick<AgentOpsContext, 'after'>,
  label: string,
  start: (onStarted: () => void) => Promise<T>,
): Promise<Started<T>> {
  let signal: () => void = () => {};
  const started = new Promise<{ kind: 'started' }>((resolve) => {
    signal = () => resolve({ kind: 'started' });
  });
  const run = start(() => signal());
  context.after(() =>
    run.then(
      () => undefined,
      (error: unknown) => {
        const code = error instanceof TeachingPackageError ? error.code : 'INTERNAL_ERROR';
        log.warn(`agent ${label} ended with ${code}`);
      },
    ),
  );
  return Promise.race([run.then((value) => ({ kind: 'settled', value }) as const), started]);
}

export interface AgentOpAnswer {
  status: 200 | 202;
  body: Record<string, unknown>;
}

function running(opId: string, extra: Record<string, unknown> = {}): AgentOpAnswer {
  return { status: 202, body: { dryRun: false, opId, status: 'running', ...extra } };
}

// ---------------------------------------------------------------------------
// regenerate / link (regenerateSlideScene)
// ---------------------------------------------------------------------------

interface RegenerationInput {
  sceneId: string;
  request: SceneRegenerationRequest;
}

function regenerationInput(body: Record<string, unknown>, link: boolean): RegenerationInput {
  const sceneId = text(body, 'sceneId')!;
  const unitId = link ? text(body, 'unitId')! : null;
  const request = parseSceneRegenerationRequest({
    instruction: body.instruction,
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
    ...(body.mode !== undefined && !link ? { mode: body.mode } : {}),
    // D-6: a link only ADDS a part; removing one is half of «Move and rewrite
    // both slides», which the agent is never offered.
    ...(unitId ? { contentUnitChange: { op: 'add', unitId } } : {}),
  });
  return { sceneId, request };
}

async function regenerationDryRun(
  context: AgentOpsContext,
  input: RegenerationInput,
): Promise<AgentOpAnswer> {
  assertEditable(context.version);
  const grant = grantOf(context);
  const live = await readLiveScene(context.pool as never, grant.stageId, input.sceneId);
  if (!live)
    throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide is not part of this stage');
  if (live.scene.type !== 'slide' && live.scene.type !== 'quiz') {
    throw new TeachingPackageError(
      'SCENE_TYPE_NOT_REGENERABLE',
      `only slides and quizzes can be regenerated; this scene is a ${live.scene.type}`,
    );
  }
  if (isBankQuizScene(live.scene)) {
    throw new TeachingPackageError(
      'BANK_QUIZ_NOT_REGENERABLE',
      'this quiz shows the approved question-bank questions; it cannot be regenerated',
    );
  }
  const now = (context.now ?? Date.now)();
  const regenerations = await listRunningSceneRegenerations(
    context.pool as never,
    grant.stageId,
    now,
  );
  if (regenerations.some((entry) => entry.sceneId === input.sceneId)) {
    throw new TeachingPackageError(
      'SCENE_REGENERATION_IN_PROGRESS',
      'another regeneration of this slide is in progress',
    );
  }
  if (await runningSceneInsertionId(context.pool as never, grant.stageId, now)) {
    throw new TeachingPackageError(
      'STAGE_GENERATION_IN_PROGRESS',
      'an AI slide insertion is running on this lesson; try again when it finishes',
    );
  }
  let unitIds: string[] | null = null;
  if (input.request.contentUnitChange) {
    const document = await loadStageDocument(context);
    const units = (
      await readAllContentUnitsForVersion(context.pool as never, grant.versionId, {
        tenantId: grant.tenantId,
      })
    ).units;
    // g5.v12: the dry run answers with the real run's block rule (book section order
    // plan); the attempt is read for that version only.
    const blocks = isBookPartPlacementModel(context.version.teachingModel)
      ? bookPartBlocksFor(
          context.version.teachingModel,
          (
            await readRetainedVersionContext(context.pool as never, grant.versionId, {
              tenantId: grant.tenantId,
            })
          )?.inputSnapshot,
        )
      : null;
    unitIds = resolveContentUnitChange(
      document.scenes.find((scene) => scene.id === input.sceneId),
      document.scenes,
      document.outline,
      units,
      input.request.contentUnitChange,
      blocks,
    ).unitIds;
  }
  return {
    status: 200,
    body: {
      dryRun: true,
      wouldRun: true,
      sceneId: input.sceneId,
      sceneType: live.scene.type,
      mode: input.request.mode ?? 'scene',
      ...(unitIds ? { sourceContentUnitIds: unitIds } : {}),
    },
  };
}

async function existingRegeneration(context: AgentOpsContext, input: RegenerationInput) {
  const prior = await readSceneRegenerationByKey(
    context.pool as never,
    context.version.id,
    input.request.idempotencyKey,
  );
  if (!prior) return null;
  if (prior.requestDigest !== sceneRegenerationRequestDigest(input.sceneId, input.request)) {
    throw new TeachingPackageError(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key was already used for a different request',
    );
  }
  return prior;
}

function linkDigest(sceneId: string, unitId: string): string {
  return agentOpDigest({ op: 'link', sceneId, unitId });
}

/**
 * D-6: a real part link needs a successful dry run by the same key, on the same slide
 * and part, younger than {@link LINK_DRY_RUN_WINDOW_MS}; else `409 LINK_DRY_RUN_REQUIRED`.
 */
async function assertLinkDryRun(
  context: AgentOpsContext,
  key: string,
  sceneId: string,
  unitId: string,
): Promise<void> {
  const record = await readAgentOpRecord(context.pool as never, {
    versionId: context.version.id,
    op: 'link-dry-run',
    idempotencyKey: key,
  });
  const now = (context.now ?? Date.now)();
  if (
    !record ||
    record.requestDigest !== linkDigest(sceneId, unitId) ||
    record.createdAt < now - LINK_DRY_RUN_WINDOW_MS
  ) {
    throw new TeachingPackageError(
      'LINK_DRY_RUN_REQUIRED',
      'linking a part changes what the send check sees: run it with dry_run=true and the same ' +
        'Idempotency-Key first (valid for 30 minutes)',
      { sceneId, unitId, windowMinutes: LINK_DRY_RUN_WINDOW_MS / 60000 },
    );
  }
}

async function regenerationOp(
  context: AgentOpsContext,
  input: RegenerationInput,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const opId = regenerationOpId(input.request.idempotencyKey);
  const change = input.request.contentUnitChange;
  const key = input.request.idempotencyKey;
  if (context.dryRun) {
    await assertStageRevision(context, expectedRevision);
    const answer = await regenerationDryRun(context, input);
    if (change && key !== DRY_RUN_KEY) {
      // D-6 "dry run first": the proof a real link by this key needs.
      await recordLinkDryRun(context.pool as never, {
        tenantId: context.tenantId,
        versionId: context.version.id,
        idempotencyKey: key,
        sceneId: input.sceneId,
        requestDigest: linkDigest(input.sceneId, change.unitId),
        now: (context.now ?? Date.now)(),
      });
    }
    return answer;
  }
  // A key that already names a run answers as that run (one generation).
  if (await existingRegeneration(context, input)) {
    return opStatus(context, opId);
  }
  if (change) await assertLinkDryRun(context, key, input.sceneId, change.unitId);
  await assertStageRevision(context, expectedRevision);
  const grant = grantOf(context);
  const outcome = await runUntilStarted(context, 'slide regeneration', (onStarted) =>
    regenerateSlideScene(grant, input.sceneId, input.request, {
      pool: context.pool,
      actor: { actorRef: context.actorRef, sessionRef: null },
      // The first calls after T1 (the row exists): the op can be answered 202.
      resolveGoverned: (...args) => {
        onStarted();
        return resolveGovernedRegenerationContext(...args);
      },
      replan: (...args) => {
        onStarted();
        return replanMovedSlide(...args);
      },
      ...(context.now ? { now: context.now } : {}),
    }),
  );
  if (outcome.kind === 'started') return running(opId, { sceneId: input.sceneId });
  const result = outcome.value;
  if (result.status === 202) return running(opId, { sceneId: input.sceneId });
  return {
    status: 200,
    body: {
      dryRun: false,
      opId,
      status: 'done',
      sceneId: result.body.sceneId,
      replayed: result.body.replayed,
      resultSceneRev: result.body.resultSceneRev,
    },
  };
}

// ---------------------------------------------------------------------------
// add-image (regenerateSlideScene + imageAddition), phase 2 F3.3
// ---------------------------------------------------------------------------

/** The agent's `{ sceneId, sourceVisualId, note? }` as a regeneration request. */
export function addImageInput(body: Record<string, unknown>): RegenerationInput {
  const sceneId = text(body, 'sceneId')!;
  const sourceVisualId = text(body, 'sourceVisualId')!;
  if (sourceVisualId.length > 200) throw invalid('sourceVisualId', 'malformed');
  const note = text(body, 'note', false);
  if (note && note.length > SLIDE_IMAGE_NOTE_MAX) throw invalid('note', 'malformed');
  // A fixed instruction and reason (the audit record; the narration directive of a slide
  // with its own part list). The note stays out of them: it reaches the model only through
  // the visual re-plan, marked as untrusted, and joins the idempotency digest.
  const request = parseSceneRegenerationRequest({
    instruction: `Add the textbook image ${sourceVisualId} to this slide and teach it in the narration`,
    reason: `agent add-image ${sourceVisualId}`,
    idempotencyKey: body.idempotencyKey,
  });
  return {
    sceneId,
    request: { ...request, imageAddition: { sourceVisualId, ...(note ? { note } : {}) } },
  };
}

async function addImageOp(
  context: AgentOpsContext,
  input: RegenerationInput,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const addition = input.request.imageAddition!;
  if (context.dryRun) {
    await assertStageRevision(context, expectedRevision);
    assertEditable(context.version);
    const document = await loadStageDocument(context);
    await checkSlideImageAddition(
      context.pool,
      document.scenes.find((scene) => scene.id === input.sceneId),
      document.outline as AppDocumentOutline | undefined,
      addition.sourceVisualId,
    );
    // The regeneration's own busy checks (no route, no row).
    const answer = await regenerationDryRun(context, input);
    return {
      status: 200,
      body: { ...answer.body, sourceVisualId: addition.sourceVisualId },
    };
  }
  // A key that already names a run answers as that run, before the checks that run moved
  // (after it, the image IS on the slide).
  const opId = regenerationOpId(input.request.idempotencyKey);
  if (await existingRegeneration(context, input)) return opStatus(context, opId);
  await assertStageRevision(context, expectedRevision);
  const grant = grantOf(context);
  // The refusals (422/409) come from the service before its row exists.
  const outcome = await runUntilStarted(context, 'slide image addition', (onStarted) =>
    regenerateSlideScene(grant, input.sceneId, input.request, {
      pool: context.pool,
      actor: { actorRef: context.actorRef, sessionRef: null },
      resolveGoverned: (...args) => {
        onStarted();
        return resolveGovernedRegenerationContext(...args);
      },
      ...(context.now ? { now: context.now } : {}),
    }),
  );
  if (outcome.kind === 'started') {
    return running(opId, { sceneId: input.sceneId, sourceVisualId: addition.sourceVisualId });
  }
  const result = outcome.value;
  if (result.status === 202) {
    return running(opId, { sceneId: input.sceneId, sourceVisualId: addition.sourceVisualId });
  }
  return {
    status: 200,
    body: {
      dryRun: false,
      opId,
      status: 'done',
      sceneId: result.body.sceneId,
      sourceVisualId: addition.sourceVisualId,
      replayed: result.body.replayed,
      resultSceneRev: result.body.resultSceneRev,
    },
  };
}

// ---------------------------------------------------------------------------
// generate (insertGeneratedSlide)
// ---------------------------------------------------------------------------

function stageRef(value: unknown): { key: string; flowIndex: number } | null {
  if (value === undefined || value === null) return null;
  const record = value as { key?: unknown; flowIndex?: unknown };
  if (
    typeof value !== 'object' ||
    typeof record.key !== 'string' ||
    record.key === '' ||
    typeof record.flowIndex !== 'number' ||
    !Number.isInteger(record.flowIndex) ||
    record.flowIndex < 0
  ) {
    throw invalid('teachingStage', 'malformed');
  }
  return { key: record.key, flowIndex: record.flowIndex };
}

/** The editor's request from the agent's `{ unitIds, afterSceneId, teachingStage?, instruction, reason }`. */
export function insertionRequestFor(
  body: Record<string, unknown>,
  scenes: readonly AppScene[],
  flow: Parameters<typeof allowedStagesAt>[1] | null,
  now: number,
): SceneInsertionRequest {
  const afterSceneId =
    body.afterSceneId === undefined || body.afterSceneId === null
      ? null
      : text(body, 'afterSceneId');
  const ordered = orderedScenes(scenes);
  const afterIndex = afterSceneId === null ? -1 : ordered.findIndex((s) => s.id === afterSceneId);
  if (afterSceneId !== null && afterIndex < 0) {
    throw new TeachingPackageError(
      'INSERTION_POSITION_NOT_ALLOWED',
      'the slide to insert after was not found',
      { reason: 'unknown_anchor' },
    );
  }
  const beforeSceneId = ordered[afterIndex + 1]?.id ?? null;
  let teachingStage = stageRef(body.teachingStage);
  if (!teachingStage) {
    const position = resolveInsertionPosition(scenes, { afterSceneId, beforeSceneId });
    const allowed = position.ok && flow ? allowedStagesAt(scenes, flow, position) : [];
    if (allowed.length !== 1) {
      throw new TeachingPackageError(
        'INSERTION_POSITION_NOT_ALLOWED',
        allowed.length === 0
          ? 'no teaching stage of this lesson allows a new slide at that position'
          : 'more than one teaching stage is allowed here; name teachingStage',
        { allowedStages: allowed },
      );
    }
    teachingStage = allowed[0]!;
  }
  return parseSceneInsertionRequest({
    unitIds: body.unitIds,
    afterSceneId,
    beforeSceneId,
    teachingStage,
    instruction: body.instruction ?? '',
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
    admitBy: now + SCENE_INSERTION_MAX_ADMISSION_WINDOW_MS,
  });
}

async function insertionDryRun(
  context: AgentOpsContext,
  request: SceneInsertionRequest,
  document: AppDocument,
  insertion: Awaited<ReturnType<typeof readInsertionContext>>,
): Promise<AgentOpAnswer> {
  if (insertion.unsupportedReason || !insertion.flow) {
    throw new TeachingPackageError(
      'INSERTION_NOT_SUPPORTED',
      'a slide cannot be generated for this package',
      { reason: insertion.unsupportedReason ?? 'no_flow' },
    );
  }
  const grant = grantOf(context);
  const now = (context.now ?? Date.now)();
  const busy =
    (await listRunningSceneInsertions(context.pool as never, grant.stageId, now)).length > 0 ||
    (await listRunningSceneRegenerations(context.pool as never, grant.stageId, now)).length > 0;
  if (busy) {
    throw new TeachingPackageError(
      'INSERTION_STAGE_BUSY',
      'a slide is being generated on this lesson; try again when it finishes',
    );
  }
  const outline = (document.outline ?? null) as AppDocumentOutline | null;
  // The service's own new-run checks, in its order, without its audit.
  const position = checkPositionAndUnits(
    request,
    document.scenes,
    outline,
    insertion.units,
    insertion.flow,
    false,
    insertion.gaps,
  );
  exactFlowOrRefuse(
    placeholderProjection(document.scenes, position.at, {
      id: 'scene_ins_dry_run',
      outlineId: 'ins_dry_run',
      teachingStage: request.teachingStage,
      stageId: grant.stageId,
    }),
    insertion.flow,
    outline,
  );
  if (insertion.governed) {
    const preCheck = preCheckExistingSceneSkills(document.scenes, insertion.flow);
    if (preCheck) throw insertionSkillsInvalidError(preCheck);
  }
  return {
    status: 200,
    body: {
      dryRun: true,
      wouldRun: true,
      unitIds: request.unitIds,
      afterSceneId: request.afterSceneId,
      beforeSceneId: request.beforeSceneId,
      teachingStage: request.teachingStage,
      position: position.at,
    },
  };
}

/**
 * The agent's own fields of a generate request against the run its key already named:
 * the parts (any order), the slide it goes after, the instruction, the reason, and the
 * teaching stage when the agent named one. Never `beforeSceneId`: it is derived from the
 * live slides, which that very run has moved.
 */
export function sameInsertionRequest(
  prior: Pick<
    SceneInsertion,
    'unitIds' | 'afterSceneId' | 'instruction' | 'reason' | 'teachingStage'
  >,
  body: Record<string, unknown>,
): boolean {
  const units = Array.isArray(body.unitIds) ? body.unitIds.map(String) : null;
  if (!units) return false;
  const sorted = (list: readonly string[]) => [...list].sort().join('\n');
  if (sorted(units) !== sorted(prior.unitIds)) return false;
  const after = typeof body.afterSceneId === 'string' ? body.afterSceneId : null;
  if (after !== prior.afterSceneId) return false;
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (instruction !== prior.instruction) return false;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason !== prior.reason) return false;
  const stage = stageRef(body.teachingStage);
  if (
    stage &&
    (stage.key !== prior.teachingStage.key || stage.flowIndex !== prior.teachingStage.flowIndex)
  ) {
    return false;
  }
  return true;
}

async function generateOp(
  context: AgentOpsContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  // A key that already names a run answers as that run, before the revision
  // check: the anchors and the coverage have moved since, by that very run.
  if (!context.dryRun && key) {
    const prior = await readSceneInsertionByKey(context.pool as never, context.version.id, key);
    if (prior) {
      if (prior.tenantId !== context.tenantId || prior.stageId !== context.version.currentStageId) {
        throw new TeachingPackageError(
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was already used',
        );
      }
      if (!sameInsertionRequest(prior, body)) {
        throw new TeachingPackageError(
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was already used for a different request',
        );
      }
      return opStatus(context, insertionOpId(key));
    }
  }
  await assertStageRevision(context, expectedRevision);
  assertEditable(context.version);
  const grant = grantOf(context);
  const insertion = await readInsertionContext(context.pool, grant);
  const document = await loadStageDocument(context);
  const now = (context.now ?? Date.now)();
  const request = insertionRequestFor(body, document.scenes, insertion.flow, now);
  if (context.dryRun) return insertionDryRun(context, request, document, insertion);

  const opId = insertionOpId(request.idempotencyKey);
  const outcome = await runUntilStarted(context, 'slide insertion', (onStarted) =>
    insertGeneratedSlide(grant, request, {
      pool: context.pool,
      actor: { actorRef: context.actorRef, sessionRef: null },
      resolveGoverned: (...args) => {
        onStarted();
        return resolveGovernedRegenerationContext(...args);
      },
      plan: (...args) => {
        onStarted();
        return planInsertedSlide(...args);
      },
      ...(context.now ? { now: context.now } : {}),
    }),
  );
  if (outcome.kind === 'started') return running(opId);
  const result = outcome.value;
  if (result.status === 202) return running(opId);
  return {
    status: 200,
    body: {
      dryRun: false,
      opId,
      status: 'done',
      sceneId: result.body.insertion.newSceneId,
      replayed: result.body.replayed,
      resultSceneRev: result.body.insertion.resultSceneRev,
    },
  };
}

// ---------------------------------------------------------------------------
// narration-audio (regenerateSceneNarrationAudio), synchronous
// ---------------------------------------------------------------------------

async function narrationOp(
  context: AgentOpsContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const sceneId = text(body, 'sceneId')!;
  const key = context.dryRun ? null : engineKey(body);
  const digest = agentOpDigest({ op: 'narration-audio', sceneId });
  const recordKey = key
    ? { versionId: context.version.id, op: 'narration-audio' as const, idempotencyKey: key }
    : null;
  // A retry by the key: "already applied", or "still running" — never a second synthesis.
  if (recordKey) {
    const prior = await readAgentOpRecord(context.pool as never, recordKey);
    const replay = prior ? narrationReplay(context, prior, digest) : null;
    if (replay) return replay;
  }
  await assertStageRevision(context, expectedRevision);
  const grant = grantOf(context);
  if (context.dryRun) {
    assertEditable(context.version);
    const now = (context.now ?? Date.now)();
    const running = await listRunningSceneRegenerations(context.pool as never, grant.stageId, now);
    if (running.some((entry) => entry.sceneId === sceneId)) {
      throw new TeachingPackageError(
        'SCENE_REGENERATION_IN_PROGRESS',
        'this slide is being regenerated; try the audio again when it finishes',
      );
    }
    const live = await readLiveScene(context.pool as never, grant.stageId, sceneId);
    if (!live) throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide was not found');
    const gap = narrationAudioGap(live.scene);
    return {
      status: 200,
      body: {
        dryRun: true,
        wouldRun: gap.missing > 0,
        sceneId,
        spoken: gap.spoken,
        missing: gap.missing,
      },
    };
  }
  const clock = context.now ?? Date.now;
  if (recordKey) {
    const claimed = await claimNarration(context.pool as never, {
      tenantId: context.tenantId,
      versionId: context.version.id,
      idempotencyKey: recordKey.idempotencyKey,
      sceneId,
      requestDigest: digest,
      now: clock(),
    });
    if (!claimed) {
      // Another request took the key meanwhile.
      const prior = await readAgentOpRecord(context.pool as never, recordKey);
      const replay = prior ? narrationReplay(context, prior, digest) : null;
      if (replay) return replay;
      throw new TeachingPackageError(
        'AGENT_OP_IN_PROGRESS',
        'the narration audio of this request is still being synthesized; read the slide later',
        { sceneId },
      );
    }
  }
  // `force: false` inside: only the lines without audio are synthesized.
  let result: Awaited<ReturnType<typeof regenerateSceneNarrationAudio>>;
  try {
    result = await regenerateSceneNarrationAudio(grant, sceneId, {
      pool: context.pool,
      actorRef: context.actorRef,
      ...(context.now ? { now: context.now } : {}),
    });
  } catch (error) {
    if (recordKey) {
      await releaseNarration(context.pool as never, recordKey).catch(() => {});
    }
    throw error;
  }
  const summary = {
    sceneId: result.sceneId,
    rev: result.rev,
    generated: result.generated,
    missing: result.missing,
  };
  if (recordKey) {
    await completeNarration(context.pool as never, {
      ...recordKey,
      result: summary,
      now: clock(),
    }).catch((error: unknown) => log.warn('could not record the narration audio op', error));
  }
  return { status: 200, body: { dryRun: false, status: 'done', ...summary } };
}

function narrationReplay(
  context: AgentOpsContext,
  prior: AgentOpRecord,
  digest: string,
): AgentOpAnswer | null {
  if (prior.requestDigest !== digest) {
    throw new TeachingPackageError(
      'IDEMPOTENCY_KEY_REUSED',
      'this idempotency key was already used for a different request',
    );
  }
  if (prior.status === 'running' && (prior.leaseUntil ?? 0) > (context.now ?? Date.now)()) {
    throw new TeachingPackageError(
      'AGENT_OP_IN_PROGRESS',
      'the narration audio of this request is still being synthesized; read the slide later',
      { sceneId: prior.sceneId },
    );
  }
  // An expired marker: the earlier run died; this request takes the marker over.
  if (prior.status === 'running') return null;
  return {
    status: 200,
    body: { dryRun: false, status: 'done', replayed: true, ...(prior.result ?? {}) },
  };
}

/** The Backend's engine key on a real op (absent → no keyed record). */
function engineKey(body: Record<string, unknown>): string | null {
  const key = body.idempotencyKey;
  if (key === undefined || key === null || key === DRY_RUN_KEY) return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw invalid('idempotencyKey', 'malformed');
  }
  return key;
}

// ---------------------------------------------------------------------------
// delete (deleteDuplicateScene)
// ---------------------------------------------------------------------------

async function deleteOp(
  context: AgentOpsContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const sceneId = text(body, 'sceneId')!;
  const keepSceneId = text(body, 'keepSceneId')!;
  const reason = text(body, 'reason')!;
  const key = context.dryRun ? null : engineKey(body);
  // A delete that already landed under this key (its record is in the delete's own
  // transaction): "done" with the backup, before the revision check it moved.
  const replayed = key
    ? await replayDuplicateDelete(context.pool, context.version.id, key, {
        sceneId,
        keepSceneId,
        reason,
      })
    : null;
  const result: DuplicateDeleteResult =
    replayed ??
    (await (async () => {
      await assertStageRevision(context, expectedRevision);
      return deleteDuplicateScene(
        grantOf(context),
        {
          sceneId,
          keepSceneId,
          reason,
          actorRef: context.actorRef,
          dryRun: context.dryRun,
          ...(key ? { idempotencyKey: key } : {}),
        },
        { pool: context.pool, ...(context.now ? { now: context.now } : {}) },
      );
    })());
  return {
    status: 200,
    body: {
      dryRun: result.dryRun,
      status: result.dryRun ? 'would_delete' : 'done',
      replayed: result.replayed,
      deleted: result.deleted,
      sceneId: result.sceneId,
      keepSceneId: result.keepSceneId,
      backup: result.backup,
    },
  };
}

// ---------------------------------------------------------------------------
// skills (setSceneTeachingSkills)
// ---------------------------------------------------------------------------

/** The live carrier with only `primary` replaced: `supporting` and `classification` stay. */
export function withPrimarySkill(
  current: SceneTeachingSkills | undefined,
  primary: { skillId: string; version: string },
): SceneTeachingSkills {
  return { ...(current ?? {}), primary };
}

function primaryRef(value: unknown): { skillId: string; version: string } {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (
    !record ||
    typeof record.skillId !== 'string' ||
    record.skillId.trim() === '' ||
    typeof record.version !== 'string' ||
    record.version.trim() === ''
  ) {
    throw invalid('primary', 'malformed');
  }
  return { skillId: record.skillId, version: record.version };
}

async function skillsOp(
  context: AgentOpsContext,
  body: Record<string, unknown>,
  expectedRevision: number,
): Promise<AgentOpAnswer> {
  const sceneId = text(body, 'sceneId')!;
  const primary = primaryRef(body.primary);
  if (!context.dryRun) {
    // A retry after an unknown outcome: the slide already carries this primary skill,
    // so the write landed (or was never needed): "already applied", before the
    // revision check that write moved.
    const current = await readLiveScene(
      context.pool as never,
      context.version.currentStageId,
      sceneId,
    );
    const had = current?.scene.teachingSkills?.primary;
    if (current && had && had.skillId === primary.skillId && had.version === primary.version) {
      return {
        status: 200,
        body: {
          dryRun: false,
          status: 'done',
          replayed: true,
          alreadyApplied: true,
          sceneId,
          updatedSceneIds: [],
          teachingSkills: current.scene.teachingSkills,
        },
      };
    }
  }
  await assertStageRevision(context, expectedRevision);
  const live = await readLiveScene(context.pool as never, context.version.currentStageId, sceneId);
  if (!live) throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide was not found');
  const teachingSkills = withPrimarySkill(live.scene.teachingSkills, primary);
  const assignment = normalizeSkillAssignment({ sceneId, teachingSkills });
  const result = await setSceneTeachingSkills(
    context.pool,
    context.version.id,
    { tenantId: context.tenantId, actorRef: context.actorRef },
    [assignment],
    { dryRun: context.dryRun },
  );
  return {
    status: 200,
    body: {
      dryRun: context.dryRun,
      status: context.dryRun ? 'would_update' : 'done',
      sceneId,
      updatedSceneIds: result.updatedSceneIds,
      teachingSkills,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function runAgentOp(
  op: AgentOp,
  context: AgentOpsContext,
  received: Record<string, unknown>,
): Promise<AgentOpAnswer> {
  const expectedRevision = parseExpectedRevision(received.expectedRevision);
  // A dry run names no run, so it needs no key; the services' parsers still want one.
  const body =
    context.dryRun && received.idempotencyKey === undefined
      ? { ...received, idempotencyKey: DRY_RUN_KEY }
      : received;
  switch (op) {
    case 'regenerate':
      return regenerationOp(context, regenerationInput(body, false), expectedRevision);
    case 'link':
      return regenerationOp(context, regenerationInput(body, true), expectedRevision);
    case 'generate':
      return generateOp(context, body, expectedRevision);
    case 'narration-audio':
      return narrationOp(context, body, expectedRevision);
    case 'delete':
      return deleteOp(context, body, expectedRevision);
    case 'skills':
      return skillsOp(context, body, expectedRevision);
    case 'add-image':
      return addImageOp(context, addImageInput(body), expectedRevision);
    case 'quiz-item-edit':
    case 'quiz-item-delete':
    case 'narration-line':
    case 'text-element':
    case 'alignment-confirm':
      return runAgentEditOp(op, context, body, expectedRevision);
  }
}

/** `GET agent-ops/ops/{opId}`: the run the op's key names, under this version and tenant. */
export async function opStatus(
  context: Pick<AgentOpsContext, 'pool' | 'version' | 'tenantId'>,
  opId: string,
): Promise<AgentOpAnswer> {
  const { kind, key } = parseOpId(opId);
  const grant = {
    tenantId: context.tenantId,
    versionId: context.version.id,
    stageId: context.version.currentStageId,
  };
  const status =
    kind === 'regeneration'
      ? await readSceneRegenerationForGrant(context.pool, grant, { idempotencyKey: key })
      : await readSceneInsertionForGrant(context.pool, grant, { idempotencyKey: key });
  const sceneId = 'newSceneId' in status ? status.newSceneId : status.sceneId;
  const state = status.status === 'succeeded' ? 'done' : status.status;
  return {
    status: state === 'running' ? 202 : 200,
    body: {
      dryRun: false,
      opId,
      kind,
      status: state,
      errorCode: status.errorCode,
      sceneId,
      resultSceneRev: status.resultSceneRev,
      requestedAt: status.requestedAt,
      completedAt: status.completedAt,
      scene: status.scene,
    },
  };
}

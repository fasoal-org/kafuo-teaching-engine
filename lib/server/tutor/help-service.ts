/**
 * Stage Help turn path (Kafuo R1 FRD HLP-01..05; contracts §0 H2, §2.2, §5;
 * plan §4.2 "Help turn", §4.3 rule 5, §8.3, §8.7 step 4, P7).
 *
 * The anchor is the learner grant's PINNED `(versionId, stageId)` plus the
 * Scene the client is on; the subject is the version's own (`grant.student.
 * subject`), never client-supplied. The Scene's `sourceContentUnitIds` are
 * resolved for the pinned version through lineage
 * (`readContentUnitsForVersion`) and selected under UNIT_CHAR_CAP
 * (`help-grounding.ts`). There is NO retrieval call on this path, ever:
 * `unavailable` lineage or an unbound Scene refuses with
 * `HELP_GROUNDING_UNAVAILABLE` before any reservation, ledger row or model
 * call; `partial` proceeds with the resolvable units and records it.
 *
 * Everything after the grounding is the shared `turn-runner` with
 * `capability='help'`, stage `help-turn`, origin `openmaic_runtime`, the
 * help-session message store, meter scope `{ helpSessionId, lessonId }` and
 * the ledger association `{ helpSessionId, sceneId, learningItem }`: same
 * idempotency, guard, budget, ledger, outbox and `done` semantics as Free
 * Chat. Follow-ups keep the anchor (one session per anchor + learner) and
 * their history is the session's messages.
 */
import { randomUUID } from 'node:crypto';

import { readContentUnitsForVersion } from '@/lib/persistence/teaching-package';
import {
  readHelpMessagesBySeq,
  readHelpSessionByAnchor,
  upsertHelpSession,
  type TurnGroundingUnit,
  type TutorHelpSession,
} from '@/lib/persistence/tutor-runtime';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { readLearnerScene, type LearnerScene } from '@/lib/server/teaching-package/learner-scene';
import { resolveSubjectModelPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import {
  MAX_MESSAGE_CHARS,
  toWireMessage,
  type WireMessage,
} from '@/lib/server/tutor/conversation-service';
import type { VerifiedLearnerGrant } from '@/lib/server/tutor/guards';
import {
  assessSceneScope,
  selectHelpUnits,
  type HelpUnitCandidate,
  type HelpUnitSelection,
  type SceneScopeAssessment,
} from '@/lib/server/tutor/help-grounding';
import {
  isHelpIntentHint,
  type AcademicBlockInput,
  type GroundingInput,
  type HelpIntentHint,
} from '@/lib/server/tutor/prompt-assembly';
import type { TutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';
import { UNIT_CHAR_CAP } from '@/lib/server/tutor/token-budget';
import {
  HELP_SESSION_TURN_STORE,
  runTutorTurn,
  type PreparedTurn,
  type PrepareContext,
} from '@/lib/server/tutor/turn-runner';

export const HELP_DEFAULT_WINDOW_LIMIT = 50;
export const HELP_MAX_STEP_REF_CHARS = 200;

// ---------------------------------------------------------------------------
// Wire shapes (contracts §5)
// ---------------------------------------------------------------------------

export interface WireHelpSession {
  id: string;
  versionId: string;
  stageId: string;
  sceneId: string;
  subjectCode: string;
  status: TutorHelpSession['status'];
  createdAt: number;
  updatedAt: number;
}

export function toWireHelpSession(session: TutorHelpSession): WireHelpSession {
  // The learner key and the student ref stay internal (BR-03).
  return {
    id: session.id,
    versionId: session.versionId,
    stageId: session.stageId,
    sceneId: session.sceneId,
    subjectCode: session.subjectCode,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Anchor resolution (grant → pinned version → Stage → Scene)
// ---------------------------------------------------------------------------

export interface HelpAnchorInput {
  versionId: unknown;
  stageId: unknown;
  sceneId: unknown;
}

function notFound(message: string): TeachingPackageError {
  // Non-enumerating: a wrong version, stage or scene reads exactly like an absent one.
  return new TeachingPackageError('NOT_FOUND', message);
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw new TeachingPackageError('INVALID_REQUEST', `${name} must be a non-empty string`);
  }
  return value;
}

/**
 * The grant must be a learner grant WITH the student block and must pin
 * exactly the `(versionId, stageId)` the client names. The grant's own
 * `stageId` match is the route's job (`forStage`); this re-checks both.
 */
export function requireLearnerAnchor(
  grant: VerifiedLearnerGrant,
  input: Pick<HelpAnchorInput, 'versionId' | 'stageId'>,
): { versionId: string; stageId: string } {
  if (grant.purpose !== 'learner' || !grant.student) {
    throw new TeachingPackageError(
      'HELP_GROUNDING_UNAVAILABLE',
      'Help requires a learner grant carrying the student context',
    );
  }
  const versionId = requireId(input.versionId, 'versionId');
  const stageId = requireId(input.stageId, 'stageId');
  if (grant.versionId !== versionId || grant.stageId !== stageId) {
    throw notFound('no Help anchor for this version and stage');
  }
  return { versionId, stageId };
}

/**
 * Pinned version → Stage document → the Scene by id, through the
 * teaching-package surface (`readLearnerScene`): every miss is a 404.
 */
export async function resolveHelpAnchor(
  deps: TutorRuntimeDeps,
  grant: VerifiedLearnerGrant,
  input: HelpAnchorInput,
): Promise<LearnerScene> {
  const { versionId, stageId } = requireLearnerAnchor(grant, input);
  const sceneId = requireId(input.sceneId, 'sceneId');
  return readLearnerScene(
    {
      pool: deps.pool,
      ...(deps.loadStageDocument ? { loadStageDocument: deps.loadStageDocument } : {}),
    },
    grant,
    { versionId, stageId, sceneId },
  );
}

// ---------------------------------------------------------------------------
// Read a session (GET /api/tutor/help/sessions)
// ---------------------------------------------------------------------------

export async function getHelpSession(
  deps: TutorRuntimeDeps,
  grant: VerifiedLearnerGrant,
  input: HelpAnchorInput & { beforeSeq?: number | null; limit?: number | null },
): Promise<{ session: WireHelpSession | null; messages: WireMessage[]; hasMore: boolean }> {
  const { versionId, stageId } = requireLearnerAnchor(grant, input);
  const sceneId = requireId(input.sceneId, 'sceneId');
  const session = await readHelpSessionByAnchor(deps.pool, {
    versionId,
    stageId,
    sceneId,
    learnerKey: grant.learnerKey,
  });
  if (!session) return { session: null, messages: [], hasMore: false };
  const window = await readHelpMessagesBySeq(deps.pool, {
    parentId: session.id,
    beforeSeq: input.beforeSeq ?? null,
    limit: input.limit && Number.isFinite(input.limit) ? input.limit : HELP_DEFAULT_WINDOW_LIMIT,
  });
  return {
    session: toWireHelpSession(session),
    messages: window.messages.map(toWireMessage),
    hasMore: window.hasMore,
  };
}

// ---------------------------------------------------------------------------
// The Scene's cited Content Units
// ---------------------------------------------------------------------------

/**
 * The Content Units a Scene cites, in cited order.
 *
 * The Scene's own `sourceContentUnitIds` when it carries the field. A Scene the
 * generation path persisted without it (CLS-C27: `api.scene.create` dropped the
 * field) still has its outline, by `outlineId`, and the builder copies exactly
 * that outline's citations onto the Scene — so the outline's list is the same
 * binding read from its source, not an inferred one. Matched by id only, never
 * by `order` (a reorder would attach another Scene's outline). No outline, or an
 * outline without ids, stays unbound.
 */
function citedContentUnitIds({ scene, document }: LearnerScene): string[] {
  if (Array.isArray(scene.sourceContentUnitIds)) {
    return scene.sourceContentUnitIds.filter(
      (id): id is string => typeof id === 'string' && id !== '',
    );
  }
  const outlineId = scene.outlineId;
  if (typeof outlineId !== 'string' || outlineId === '') return [];
  const outlines = (document.outline as { outlines?: unknown } | undefined)?.outlines;
  if (!Array.isArray(outlines)) return [];
  const outline = outlines.find(
    (entry): entry is { id: string; sourceContentUnitIds?: unknown } =>
      typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === outlineId,
  );
  const ids = outline?.sourceContentUnitIds;
  if (!Array.isArray(ids)) return [];
  // The outline gate accepts a model's numeric ids as faithful citations and
  // stores them as strings (`outline-grounding.ts`); read them the same way.
  return ids
    .map((id) => (typeof id === 'number' && Number.isFinite(id) ? String(id) : id))
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

// ---------------------------------------------------------------------------
// The Help turn (POST /api/tutor/help/turns)
// ---------------------------------------------------------------------------

export interface HelpTurnInput extends HelpAnchorInput {
  grant: VerifiedLearnerGrant;
  stepRef?: unknown;
  clientMessageId: unknown;
  text: unknown;
  intentHint?: unknown;
  requestSignal?: AbortSignal;
}

function academicBlockOf(grant: VerifiedLearnerGrant): AcademicBlockInput {
  const { academic, subject } = grant.student;
  return {
    subjectNameAr: subject.nameAr,
    subjectNameEn: subject.nameEn,
    curriculumName: academic.curriculumName,
    curriculumVersionLabel: academic.curriculumVersionLabel,
    gradeLabel: academic.gradeLabel,
    academicLanguage: subject.academicLanguage,
  };
}

export async function runHelpTurn(deps: TutorRuntimeDeps, input: HelpTurnInput): Promise<Response> {
  const { grant } = input;
  if (
    typeof input.clientMessageId !== 'string' ||
    input.clientMessageId.length === 0 ||
    input.clientMessageId.length > 128
  ) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      'clientMessageId must be a string of at most 128 chars',
    );
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new TeachingPackageError('INVALID_REQUEST', 'text must be a non-empty string');
  }
  if (input.text.length > MAX_MESSAGE_CHARS) {
    throw new TeachingPackageError(
      'REQUEST_TOO_LARGE',
      `text must be at most ${MAX_MESSAGE_CHARS} characters`,
    );
  }
  let stepRef: string | null = null;
  if (input.stepRef !== undefined && input.stepRef !== null) {
    if (typeof input.stepRef !== 'string' || input.stepRef.length > HELP_MAX_STEP_REF_CHARS) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        `stepRef must be a string of at most ${HELP_MAX_STEP_REF_CHARS} chars`,
      );
    }
    stepRef = input.stepRef;
  }
  let intentHint: HelpIntentHint | null = null;
  if (input.intentHint !== undefined && input.intentHint !== null) {
    if (!isHelpIntentHint(input.intentHint)) {
      throw new TeachingPackageError(
        'INVALID_REQUEST',
        'intentHint must be one of explain, simplify, hint, check_answer',
      );
    }
    intentHint = input.intentHint;
  }
  const text = input.text;

  // --- anchor: grant → pinned version → Stage → Scene ---------------------------
  const anchor = await resolveHelpAnchor(deps, grant, input);
  const { version, scene } = anchor;
  const sceneId = scene.id;

  // --- subject: the version's own, from the grant's snapshot (ROUTE-01) -----------
  const subjectCode = grant.student.subject.code;
  if (subjectCode === null || !isSubjectCode(subjectCode)) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject ${subjectCode ?? '(none)'} has no approved route`,
      { subjectCode },
    );
  }
  const policy = await resolveSubjectModelPolicy(subjectCode);

  // --- Scene → Content Units through the pinned version's lineage (§8.3) -----------
  const citedIds = citedContentUnitIds(anchor);
  if (citedIds.length === 0) {
    throw new TeachingPackageError(
      'HELP_GROUNDING_UNAVAILABLE',
      'this Scene has no Content Unit binding; Scene evidence cannot be established',
    );
  }
  const lineage = await readContentUnitsForVersion(deps.pool, version.id, citedIds, {
    tenantId: grant.tenantId,
  });
  const lineageStatus = lineage.lineageStatus;
  if (lineageStatus === 'unavailable' || lineage.units.length === 0) {
    throw new TeachingPackageError(
      'HELP_GROUNDING_UNAVAILABLE',
      'the Scene’s Content Units are not available for the pinned version',
      { lineageStatus },
    );
  }
  // Candidates in CITED order (the resolver returns manifest order).
  const byId = new Map(lineage.units.map((unit) => [unit.unitId, unit]));
  const candidates: HelpUnitCandidate[] = [];
  for (const id of citedIds) {
    const unit = byId.get(id);
    if (unit)
      candidates.push({ unitId: unit.unitId, title: unit.title, text: unit.normalizedText });
  }

  // --- selection under UNIT_CHAR_CAP + the Scene-scope rule (HLP-02/04) -------------
  const scope = assessSceneScope({
    question: text,
    sceneTitle: anchor.sceneTitle,
    visibleStepText: anchor.sceneText,
    units: candidates,
  });
  const selection = selectHelpUnits({
    candidates,
    question: text,
    sceneTitle: anchor.sceneTitle,
    visibleStepText: anchor.sceneText,
    cap: UNIT_CHAR_CAP,
  });

  // --- the session: one per (version, stage, scene, learner) anchor ------------------
  const session = await upsertHelpSession(deps.pool, {
    id: `hs-${(deps.idFactory ?? randomUUID)()}`,
    tenantId: grant.tenantId,
    versionId: version.id,
    stageId: version.currentStageId,
    sceneId,
    learnerKey: grant.learnerKey,
    studentRef: grant.student.studentRef,
    subjectCode,
    now: deps.now() / 1000,
  });

  const academic = academicBlockOf(grant);
  return runTutorTurn(
    {
      store: HELP_SESSION_TURN_STORE,
      parent: { id: session.id, tenantId: session.tenantId, studentRef: session.studentRef },
      policy,
      capability: 'help',
      stage: 'help-turn',
      clientMessageId: input.clientMessageId,
      text,
      localeHint: grant.student.localeHint ?? null,
      academicLanguage: academic.academicLanguage,
      stepRef,
      intentHint,
      meterScope: { helpSessionId: session.id, lessonId: version.learningItem.id },
      association: {
        sceneId,
        learningItemType: version.learningItem.type,
        learningItemId: version.learningItem.id,
      },
      requestSignal: input.requestSignal,
      prepare: (ctx) =>
        prepareHelpTurn(ctx, {
          academic,
          anchor,
          candidates,
          selection,
          scope,
          lineage: { status: lineageStatus, resolvedAttemptId: lineage.resolvedAttemptId },
          stepRef,
          intentHint,
        }),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Help prepare: Scene grounding (no assessment call, no retrieval)
// ---------------------------------------------------------------------------

interface HelpPrepareInput {
  academic: AcademicBlockInput;
  anchor: LearnerScene;
  candidates: HelpUnitCandidate[];
  selection: HelpUnitSelection;
  scope: SceneScopeAssessment;
  lineage: {
    status: 'own_attempt' | 'predecessor_attempt' | 'partial';
    resolvedAttemptId: string | null;
  };
  stepRef: string | null;
  intentHint: HelpIntentHint | null;
}

export async function prepareHelpTurn(
  ctx: PrepareContext,
  input: HelpPrepareInput,
): Promise<PreparedTurn> {
  const { selection, scope, lineage, anchor } = input;
  const outside = scope.decision === 'outside_scene';
  const partialCoverage = selection.capped || lineage.status === 'partial';

  const grounding: GroundingInput = outside
    ? { mode: 'insufficient' }
    : {
        mode: 'scene',
        sceneTitle: anchor.sceneTitle || null,
        sceneText: anchor.sceneText || null,
        units: selection.units.map((unit) => ({
          title: unit.title,
          text: unit.text,
          score: unit.score,
          ...(unit.truncated ? { truncated: true } : {}),
        })),
        coverage: partialCoverage ? 'partial' : 'complete',
      };

  const auditUnits: TurnGroundingUnit[] = outside
    ? []
    : selection.units.map((unit, index) => ({
        unitId: unit.unitId,
        title: unit.title,
        chars: unit.chars,
        orderIndex: index,
      }));

  return {
    academic: input.academic,
    grounding,
    history: { turns: ctx.history },
    helpMode: true,
    lessonTitle: anchor.document.stage.name ?? null,
    // FC-A05 (D-2 a): additive SSE-only reason so the app can show the scope notice and the
    // Free Chat button. `grounding` above stays reason-less: the prompt does not change.
    ...(outside ? { groundingEvent: { reason: 'outside_scene' } } : {}),
    audit: {
      assessment: {
        decision: outside ? 'outside_scene' : 'scene',
        rule: outside ? 'scene_zero_overlap' : 'scene_anchor',
        overlap: scope.overlap,
        keywordCount: scope.keywordCount,
        sceneId: anchor.scene.id,
        stepRef: input.stepRef,
        intentHint: input.intentHint,
        lineageStatus: lineage.status,
        candidateCount: input.candidates.length,
        selectedCount: outside ? 0 : selection.units.length,
        capped: selection.capped,
        droppedUnitIds: selection.droppedUnitIds,
        turnId: ctx.turnId,
      },
      units: auditUnits,
      totalChars: outside ? 0 : Math.min(selection.totalChars, UNIT_CHAR_CAP),
      truncated: outside ? false : selection.truncated,
      lineageStatus: lineage.status,
      resolvedAttemptId: lineage.resolvedAttemptId,
    },
  };
}

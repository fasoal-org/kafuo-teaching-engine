/**
 * Free Chat conversation service (Kafuo R1 FRD FCH-01..04, CTX-01..05,
 * CHAT-01..04; contracts §5; plan §4.2, §4.3, §8.2, §8.5).
 *
 * The routes under `app/api/tutor/conversations/**` are thin: grant → this
 * service → wire shape. Ownership is `(tenantId, studentRef)` from the grant
 * on every read, resume and send; a mismatch reads exactly like an absent
 * row (404 CONVERSATION_NOT_FOUND, non-enumerating). The subject is pinned at
 * creation from the grant's allowed list (403 SUBJECT_NOT_ALLOWED otherwise)
 * and re-validated under the CURRENT grant on send only
 * (403 SUBJECT_NO_LONGER_AVAILABLE) — listing and reading an old
 * conversation still works. `lessonId` is never accepted from the client.
 *
 * The turn itself runs through `runTutorTurn`; this module supplies the Free
 * Chat `prepare` (assessment → reuse / retrieve / none / clarification,
 * snapshot, item association) and `afterCommit` (title, optional compaction).
 *
 * Grounding source (discovery-first plan P7, `TUTOR_GROUNDING_SOURCE`):
 *  - `kafuo_http` (default) and `shadow` (a stub until P6, recorded as
 *    "shadow not available"): the existing `grounding/search` call, unchanged
 *    request and SSE frames; writes the rollback-only schema-1 association
 *    and a `kafuo_http`-tagged snapshot.
 *  - `direct` (config + `TUTOR_GROUNDING_DIRECT_TENANTS` + a wired reader):
 *    the discovery-first flow through the Kafuo grounding reader seam
 *    (`grounding/direct-grounding.ts`), association v2 and snapshot v2.
 * A Kafuo scope refusal on either path refuses the turn with
 * SUBJECT_NO_LONGER_AVAILABLE (D-18) before any reservation.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import {
  archiveConversation,
  associationTitle,
  insertConversationIdempotent,
  listConversationsByStudent,
  readConversationByClientRequestId,
  readMessagesBySeq,
  readOwnedConversation,
  unarchiveConversation,
  updateConversationLessonAssociation,
  updateConversationPendingClarification,
  writeGroundingSnapshot,
  type ConversationAcademic,
  type ConversationAssociation,
  type ConversationStatus,
  type DirectSnapshotUnit,
  type GroundingSnapshot,
  type GroundingSourceTag,
  type HttpSnapshotUnit,
  type ItemAssociationV2,
  type LearningItemType,
  type PendingClarification,
  type TurnGroundingUnit,
  type TutorConversation,
  type TutorMessage,
} from '@/lib/persistence/tutor-runtime';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { resolveSubjectModelPolicy, type ResolvedSubjectPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import { compactConversation, isCompactionEnabled } from '@/lib/server/tutor/compaction';
import {
  assessContext,
  decideLessonAssociation,
  groundingKeywords,
  type ContextAssessment,
} from '@/lib/server/tutor/context-assessment';
import { clarificationText, matchClarificationReply } from '@/lib/server/tutor/grounding/clarification';
import {
  accessLost,
  retrieveDirect,
  revalidateUnits,
  RetrievalClock,
  runDiscoveryProbe,
  type DirectRetrievalResult,
  type RetrievalTimings,
} from '@/lib/server/tutor/grounding/direct-grounding';
import { assessmentRuleset, resolveGroundingRoute } from '@/lib/server/tutor/grounding/grounding-config';
import type {
  DirectGroundingDeps,
  ResolveItemsResult,
} from '@/lib/server/tutor/grounding/kafuo-grounding-reader';
import {
  KafuoIntegrationError,
  type GroundingSearchResponse,
} from '@/lib/server/tutor/kafuo-integration-client';
import type {
  AcademicBlockInput,
  GroundingInput,
  InsufficientReason,
} from '@/lib/server/tutor/prompt-assembly';
import { toGroundingUnitInput } from '@/lib/server/tutor/prompt-assembly';
import type { TutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';
import type { StudentGrantPayload } from '@/lib/server/tutor/student-grant';
import { ensureConversationTitle } from '@/lib/server/tutor/title';
import { UNIT_CHAR_CAP, resolveProxyRatio } from '@/lib/server/tutor/token-budget';
import {
  CONVERSATION_TURN_STORE,
  runTutorTurn,
  type CommittedTurn,
  type PreparedTurn,
  type PrepareContext,
} from '@/lib/server/tutor/turn-runner';

const log = createLogger('TutorConversations');

export const MAX_MESSAGE_CHARS = 4_000;
export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_WINDOW_LIMIT = 50;

// ---------------------------------------------------------------------------
// Wire shapes (contracts §5)
// ---------------------------------------------------------------------------

export interface WireConversation {
  id: string;
  subjectCode: string;
  subjectName: string;
  academic: ConversationAcademic;
  title: string | null;
  titleSource: string | null;
  status: ConversationStatus;
  lessonAssociation: { lessonTitle: string; confidence: number } | null;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
}

export interface WireMessage {
  id: string;
  seq: number;
  role: 'student' | 'tutor';
  text: string;
  status: string;
  servedBy?: string;
  groundingMode?: string;
  safety?: Record<string, unknown>;
  errorCode?: string;
  clientMessageId?: string;
  createdAt: number;
  completedAt?: number;
}

export function toWireConversation(c: TutorConversation): WireConversation {
  return {
    id: c.id,
    subjectCode: c.subjectCode,
    subjectName: c.subjectName,
    academic: c.academic,
    title: c.title,
    titleSource: c.titleSource,
    status: c.status,
    // The internal learning item id stays internal (BR-03): only the title and confidence go out.
    lessonAssociation: c.lessonAssociation
      ? { lessonTitle: associationTitle(c.lessonAssociation), confidence: c.lessonAssociation.confidence }
      : null,
    messageCount: c.messageCount,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
  };
}

export function toWireMessage(m: TutorMessage): WireMessage {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    text: m.text,
    status: m.status,
    ...(m.servedBy ? { servedBy: m.servedBy } : {}),
    ...(m.groundingMode ? { groundingMode: m.groundingMode } : {}),
    ...(m.safety ? { safety: m.safety } : {}),
    ...(m.errorCode ? { errorCode: m.errorCode } : {}),
    ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
    createdAt: m.createdAt,
    ...(m.completedAt !== null ? { completedAt: m.completedAt } : {}),
  };
}

function owner(grant: StudentGrantPayload) {
  return { tenantId: grant.tenantId, studentRef: grant.studentRef };
}

function academicBlockOf(conversation: TutorConversation): AcademicBlockInput {
  const a = conversation.academic;
  return {
    subjectNameAr: a.subjectNameAr ?? conversation.subjectName,
    subjectNameEn: a.subjectNameEn ?? conversation.subjectName,
    curriculumName: a.curriculumName,
    curriculumVersionLabel: a.curriculumVersionLabel,
    gradeLabel: a.gradeLabel,
    academicLanguage: a.academicLanguage,
  };
}

// ---------------------------------------------------------------------------
// Create / list / read / archive
// ---------------------------------------------------------------------------

export interface CreateConversationInput {
  grant: StudentGrantPayload;
  subjectCode: unknown;
  clientRequestId: unknown;
}

export async function createConversation(
  deps: TutorRuntimeDeps,
  input: CreateConversationInput,
): Promise<{ conversation: TutorConversation; created: boolean }> {
  const { grant } = input;
  if (typeof input.subjectCode !== 'string' || input.subjectCode.trim() === '') {
    throw new TeachingPackageError('INVALID_REQUEST', 'subjectCode must be a non-empty string');
  }
  if (
    input.clientRequestId !== undefined &&
    (typeof input.clientRequestId !== 'string' || input.clientRequestId.length === 0 || input.clientRequestId.length > 128)
  ) {
    throw new TeachingPackageError('INVALID_REQUEST', 'clientRequestId must be a string of at most 128 chars');
  }
  if (!grant.entitlements.freeChat) {
    throw new TeachingPackageError('SUBJECT_NOT_ALLOWED', 'Free Chat is not enabled for this student');
  }
  const subject = grant.allowedSubjects.find((s) => s.code === input.subjectCode);
  if (!subject) {
    throw new TeachingPackageError('SUBJECT_NOT_ALLOWED', `subject ${input.subjectCode} is not in the student grant`);
  }
  // `code === null` (no routing key upstream) reads exactly like an unrouted code.
  if (subject.code === null || !isSubjectCode(subject.code)) {
    throw new TeachingPackageError('SUBJECT_ROUTE_UNAVAILABLE', `subject ${subject.code ?? '(none)'} has no approved route`);
  }
  // Resolvable now, or the first turn would fail after creation.
  await resolveSubjectModelPolicy(subject.code);

  const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId : null;
  const nowS = deps.now() / 1000;
  const academic: ConversationAcademic = {
    ...(grant.academic.curriculumId ? { curriculumId: grant.academic.curriculumId } : {}),
    curriculumName: grant.academic.curriculumName,
    curriculumVersionLabel: grant.academic.curriculumVersionLabel,
    gradeLabel: grant.academic.gradeLabel,
    academicLanguage: subject.academicLanguage,
    subjectNameAr: subject.nameAr,
    subjectNameEn: subject.nameEn,
  };
  const inserted = await insertConversationIdempotent(deps.pool, {
    id: `conv-${(deps.idFactory ?? randomUUID)()}`,
    tenantId: grant.tenantId,
    studentRef: grant.studentRef,
    subjectCode: subject.code,
    subjectOfferingId: subject.offeringId,
    subjectName:
      (subject.academicLanguage.toLowerCase().startsWith('ar') ? subject.nameAr : subject.nameEn) ??
      subject.nameEn ??
      subject.nameAr ??
      subject.code,
    academic,
    now: nowS,
    clientRequestId,
  });
  if (inserted) return { conversation: inserted, created: true };
  const existing = clientRequestId
    ? await readConversationByClientRequestId(deps.pool, owner(grant), clientRequestId)
    : null;
  if (!existing) throw new Error('conversation insert returned nothing and no replay row exists');
  if (existing.subjectCode !== subject.code) {
    throw new TeachingPackageError('IDEMPOTENCY_CONFLICT', 'clientRequestId was used for another subject');
  }
  return { conversation: existing, created: false };
}

export async function listConversations(
  deps: TutorRuntimeDeps,
  grant: StudentGrantPayload,
  options: { status?: string | null; cursor?: string | null; limit?: number | null },
): Promise<{ items: WireConversation[]; nextCursor: string | null }> {
  const status: ConversationStatus = options.status === 'archived' ? 'archived' : 'active';
  const limit = options.limit && Number.isFinite(options.limit) ? options.limit : DEFAULT_LIST_LIMIT;
  const page = await listConversationsByStudent(deps.pool, {
    ...owner(grant),
    status,
    cursor: options.cursor ?? null,
    limit,
  });
  return { items: page.items.map(toWireConversation), nextCursor: page.nextCursor };
}

async function requireOwned(
  deps: TutorRuntimeDeps,
  grant: StudentGrantPayload,
  id: string,
): Promise<TutorConversation> {
  const conversation = await readOwnedConversation(deps.pool, id, owner(grant));
  if (!conversation) {
    throw new TeachingPackageError('CONVERSATION_NOT_FOUND', 'conversation not found');
  }
  return conversation;
}

export async function getConversation(
  deps: TutorRuntimeDeps,
  grant: StudentGrantPayload,
  id: string,
  options: { beforeSeq?: number | null; limit?: number | null },
): Promise<{ conversation: WireConversation; messages: WireMessage[]; hasMore: boolean }> {
  const conversation = await requireOwned(deps, grant, id);
  const window = await readMessagesBySeq(deps.pool, {
    parentId: conversation.id,
    beforeSeq: options.beforeSeq ?? null,
    limit: options.limit && Number.isFinite(options.limit) ? options.limit : DEFAULT_WINDOW_LIMIT,
  });
  return {
    conversation: toWireConversation(conversation),
    messages: window.messages.map(toWireMessage),
    hasMore: window.hasMore,
  };
}

export async function setArchived(
  deps: TutorRuntimeDeps,
  grant: StudentGrantPayload,
  id: string,
  archived: boolean,
): Promise<WireConversation> {
  const nowS = deps.now() / 1000;
  const updated = archived
    ? await archiveConversation(deps.pool, id, owner(grant), nowS)
    : await unarchiveConversation(deps.pool, id, owner(grant), nowS);
  if (!updated) throw new TeachingPackageError('CONVERSATION_NOT_FOUND', 'conversation not found');
  return toWireConversation(updated);
}

// ---------------------------------------------------------------------------
// Send a message (the Free Chat turn)
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  grant: StudentGrantPayload;
  conversationId: string;
  clientMessageId: unknown;
  text: unknown;
  localeHint?: unknown;
  requestSignal?: AbortSignal;
}

/** Background work launched after `done` (compaction); tests await it. */
const BACKGROUND_KEY = Symbol.for('openmaic.tutor.background-tasks');
function backgroundTasks(): Set<Promise<unknown>> {
  const registry = globalThis as Record<symbol, Set<Promise<unknown>> | undefined>;
  return (registry[BACKGROUND_KEY] ??= new Set());
}
export async function awaitTutorBackgroundTasks(): Promise<void> {
  await Promise.allSettled([...backgroundTasks()]);
}
function launchBackground(task: Promise<unknown>): void {
  const set = backgroundTasks();
  set.add(task);
  void task.finally(() => set.delete(task));
}

export async function sendMessage(deps: TutorRuntimeDeps, input: SendMessageInput): Promise<Response> {
  const { grant } = input;
  if (typeof input.clientMessageId !== 'string' || input.clientMessageId.length === 0 || input.clientMessageId.length > 128) {
    throw new TeachingPackageError('INVALID_REQUEST', 'clientMessageId must be a string of at most 128 chars');
  }
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new TeachingPackageError('INVALID_REQUEST', 'text must be a non-empty string');
  }
  if (input.text.length > MAX_MESSAGE_CHARS) {
    throw new TeachingPackageError('REQUEST_TOO_LARGE', `text must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  const localeHint =
    typeof input.localeHint === 'string' && input.localeHint.length <= 16 ? input.localeHint : null;
  const text = input.text;

  const conversation = await requireOwned(deps, grant, input.conversationId);
  if (conversation.status !== 'active') {
    throw new TeachingPackageError('INVALID_TRANSITION', 'the conversation is archived; unarchive it first');
  }
  // Resume re-validates the pinned subject under the CURRENT grant (send only).
  if (!grant.entitlements.freeChat || !grant.allowedSubjects.some((s) => s.code === conversation.subjectCode)) {
    throw new TeachingPackageError(
      'SUBJECT_NO_LONGER_AVAILABLE',
      `subject ${conversation.subjectCode} is no longer available to this student`,
    );
  }
  const policy = await resolveSubjectModelPolicy(conversation.subjectCode);
  const academic = academicBlockOf(conversation);
  const proxyTarget = [policy.primary, policy.fallback].find((t) => t.counterKind === 'proxy');
  const proxyRatio = proxyTarget
    ? await resolveProxyRatio(proxyTarget.modelString, deps.executor?.proxyRatioReader)
    : null;
  const executorOptions = { queryable: deps.pool, now: deps.now, workerId: deps.workerId, ...(deps.executor ?? {}) };

  return runTutorTurn(
    {
      store: CONVERSATION_TURN_STORE,
      parent: { id: conversation.id, tenantId: conversation.tenantId, studentRef: conversation.studentRef },
      policy,
      capability: 'free_chat',
      stage: 'free-chat-turn',
      clientMessageId: input.clientMessageId,
      text,
      localeHint,
      meterScope: { conversationId: conversation.id },
      requestSignal: input.requestSignal,
      prepare: (ctx) => prepareFreeChatTurn(deps, conversation, academic, ctx),
      afterCommit: (info) => afterFreeChatTurn(deps, conversation, policy, academic, proxyRatio, executorOptions, info),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Free Chat prepare: assessment → (probe) → reuse / retrieve / none / clarification
// ---------------------------------------------------------------------------

/**
 * One turn's grounding decision, whichever source served it. `buildPreparedTurn`
 * turns it into the runner's `PreparedTurn`.
 */
interface FreeChatGrounding {
  source: GroundingSourceTag;
  grounding: GroundingInput;
  /** Student-visible item title: only when this turn's evidence is the associated item's. */
  lessonTitle: string | null;
  /** SSE extras — sent by the `direct` path only (the HTTP path's frames stay unchanged). */
  eventItemType: LearningItemType | null;
  eventReason: InsufficientReason | null;
  /** `tutor_turn_groundings.outcome_reason` (both paths). */
  outcomeReason: string | null;
  nextSnapshot: GroundingSnapshot | null;
  association: { kind: 'keep' } | { kind: 'set'; value: ConversationAssociation } | { kind: 'clear' };
  auditUnits: TurnGroundingUnit[];
  totalChars: number;
  truncated: boolean;
  assessmentExtra: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  timings: RetrievalTimings | null;
  embedding: { model: string; tokens: number | null } | null;
  clarification: { text: string; candidates: PendingClarification['candidates'] } | null;
}

function emptyGrounding(source: GroundingSourceTag): FreeChatGrounding {
  return {
    source,
    grounding: { mode: 'none' },
    lessonTitle: null,
    eventItemType: null,
    eventReason: null,
    outcomeReason: null,
    nextSnapshot: null,
    association: { kind: 'keep' },
    auditUnits: [],
    totalChars: 0,
    truncated: false,
    assessmentExtra: {},
    resolution: null,
    timings: null,
    embedding: null,
    clarification: null,
  };
}

function snapshotItemTitle(snapshot: GroundingSnapshot, itemId: string): string | null {
  return snapshot.source === 'direct'
    ? (snapshot.items.find((item) => item.itemId === itemId)?.title ?? null)
    : null;
}

/** Snapshot → assembler units (ids dropped; direct units keep their item for the headers). */
function snapshotUnitsToInput(snapshot: GroundingSnapshot) {
  if (snapshot.source === 'direct') {
    return snapshot.units.map((unit) =>
      toGroundingUnitInput({
        title: unit.title,
        text: unit.text,
        item: { key: unit.itemId, title: snapshotItemTitle(snapshot, unit.itemId), itemType: unit.itemType },
      }),
    );
  }
  return snapshot.units.map((unit) => toGroundingUnitInput({ title: unit.title, text: unit.text }));
}

function auditUnits(snapshot: GroundingSnapshot): TurnGroundingUnit[] {
  if (snapshot.source === 'direct') {
    return snapshot.units.map((unit, index) => ({
      unitId: unit.unitId,
      itemId: unit.itemId,
      itemType: unit.itemType,
      buildId: unit.buildId,
      revisionId: unit.revisionId,
      title: unit.title,
      chars: unit.chars,
      orderIndex: index,
    }));
  }
  return snapshot.units.map((unit, index) => ({
    unitId: unit.unitId,
    lessonId: unit.lessonId ?? null,
    title: unit.title,
    chars: unit.chars,
    orderIndex: index,
  }));
}

function snapshotChars(snapshot: GroundingSnapshot): number {
  return snapshot.units.reduce((sum, unit) => sum + unit.chars, 0);
}

/**
 * The associated item when EVERY unit of the snapshot comes from it (F-T3:
 * the title is shown only for the associated item's own evidence). Compared on
 * the full `(schema, type, id)` tuple.
 */
function associationOfSnapshot(
  snapshot: GroundingSnapshot,
  association: ConversationAssociation | null,
): ConversationAssociation | null {
  if (!association || snapshot.units.length === 0) return null;
  if (association.schema === 2) {
    return snapshot.source === 'direct' &&
      snapshot.units.every(
        (unit) =>
          unit.itemId === association.learningItemId &&
          unit.itemType === association.learningItemType,
      )
      ? association
      : null;
  }
  return snapshot.source === 'kafuo_http' &&
    snapshot.units.every((unit) => unit.lessonId === association.lessonId)
    ? association
    : null;
}

function reuseGrounding(
  source: GroundingSourceTag,
  snapshot: GroundingSnapshot,
  association: ConversationAssociation | null,
  seq: number,
  emitExtras: boolean,
): FreeChatGrounding {
  const owner = associationOfSnapshot(snapshot, association);
  const lessonTitle = owner ? associationTitle(owner) : null;
  const itemType = owner && owner.schema === 2 ? owner.learningItemType : null;
  return {
    ...emptyGrounding(source),
    grounding: {
      mode: 'reuse',
      lessonTitle,
      ...(itemType ? { itemType } : {}),
      units: snapshotUnitsToInput(snapshot),
    },
    lessonTitle,
    eventItemType: emitExtras ? itemType : null,
    nextSnapshot: { ...snapshot, lastUsedSeq: seq },
    auditUnits: auditUnits(snapshot),
    totalChars: snapshotChars(snapshot),
  };
}

/** D-18 on the HTTP path: Kafuo's definitive scope refusal (404 student_ref_unknown / 403 offering_not_permitted). */
function httpAccessDenied(error: unknown): 'student_ref_unknown' | 'offering_not_permitted' | null {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
  };
  if (!(error instanceof KafuoIntegrationError) && record.name !== 'KafuoIntegrationError') return null;
  if (record.code === 'student_ref_unknown' || record.code === 'offering_not_permitted') {
    return record.code;
  }
  return record.status === 403 ? 'offering_not_permitted' : null;
}

/**
 * The temporary `kafuo_http` path (also `shadow` until P6): the existing
 * `grounding/search` call, byte-for-byte the same request. It writes the
 * rollback-only schema-1 association (never over a v2) and a snapshot tagged
 * `kafuo_http`. Its SSE frames carry no P7 extras.
 */
async function groundOverHttp(
  deps: TutorRuntimeDeps,
  conversation: TutorConversation,
  ctx: PrepareContext,
  assessment: ContextAssessment,
  source: 'kafuo_http' | 'shadow',
): Promise<FreeChatGrounding> {
  const seq = ctx.studentMessage.seq;
  const snapshot = conversation.grounding;
  const current = conversation.lessonAssociation;
  const base = emptyGrounding(source);

  if (assessment.decision === 'reuse' && snapshot) {
    return reuseGrounding(source, snapshot, current, seq, false);
  }
  if (assessment.decision !== 'retrieve') return base;

  let response: GroundingSearchResponse | null = null;
  let retrieval: 'ok' | 'empty' | 'unavailable' | null = null;
  try {
    response = await deps.kafuo.groundingSearch({
      tenantId: conversation.tenantId,
      studentRef: conversation.studentRef,
      subjectOfferingId: conversation.subjectOfferingId,
      query: assessment.query ?? ctx.studentMessage.text.slice(0, 200),
      maxChars: UNIT_CHAR_CAP,
      ...(snapshot ? { preferredContentUnitIds: snapshot.units.map((unit) => unit.unitId) } : {}),
    });
  } catch (error) {
    const denied = httpAccessDenied(error);
    if (denied) throw accessLost(denied);
    retrieval = 'unavailable';
    log.warn(
      JSON.stringify({
        event: 'tutor.grounding_unavailable',
        turnId: ctx.turnId,
        error: describeErrorSafely(error).name,
      }),
    );
  }
  const resolution = source === 'shadow' ? { shadow: 'not_available' } : null;
  if (!response || response.units.length === 0) {
    if (retrieval === null) retrieval = 'empty';
    return {
      ...base,
      grounding: { mode: 'insufficient' },
      outcomeReason: retrieval === 'unavailable' ? 'retrieval_unavailable' : 'below_evidence_floor',
      assessmentExtra: { retrieval },
      resolution,
    };
  }
  const match = decideLessonAssociation(response);
  const units: HttpSnapshotUnit[] = response.units.map((unit) => ({
    source: 'kafuo_http',
    unitId: unit.contentUnitId,
    lessonId: unit.lessonId || null,
    lessonTitle: unit.lessonTitle || null,
    title: unit.unitTitle || null,
    text: unit.text,
    chars: unit.text.length,
  }));
  const nextSnapshot: GroundingSnapshot = {
    schema: 2,
    source: 'kafuo_http',
    units,
    keywords: groundingKeywords(response.units),
    setAtSeq: seq,
    lastUsedSeq: seq,
  };
  // Rollback-only schema 1: never replaces a v2, never rewrites the same lesson.
  const writeV1 =
    match !== null &&
    current?.schema !== 2 &&
    !(current?.schema === 1 && current.lessonId === match.lessonId);
  return {
    ...base,
    grounding: {
      mode: 'retrieved',
      lessonTitle: match ? match.lessonTitle : null,
      units: response.units.map((unit) =>
        toGroundingUnitInput({ unitTitle: unit.unitTitle, text: unit.text, score: unit.score }),
      ),
    },
    lessonTitle: match ? match.lessonTitle : null,
    nextSnapshot,
    association: writeV1
      ? {
          kind: 'set',
          value: {
            schema: 1,
            lessonId: match!.lessonId,
            lessonTitle: match!.lessonTitle,
            confidence: match!.confidence,
            associatedAtSeq: seq,
          },
        }
      : { kind: 'keep' },
    auditUnits: auditUnits(nextSnapshot),
    totalChars: snapshotChars(nextSnapshot),
    truncated: response.truncated,
    assessmentExtra: {
      retrieval: 'ok',
      ...(match ? { lessonMatchConfidence: match.confidence } : {}),
    },
    resolution,
  };
}

/** The original question of a pending clarification (its text, never stored elsewhere). */
async function questionText(
  deps: TutorRuntimeDeps,
  conversationId: string,
  ctx: PrepareContext,
  questionSeq: number,
): Promise<string | null> {
  const inWindow = ctx.historyMessages.find((m) => m.seq === questionSeq && m.role === 'student');
  if (inWindow) return inWindow.text;
  const { messages } = await readMessagesBySeq(deps.pool, {
    parentId: conversationId,
    beforeSeq: questionSeq + 1,
    limit: 1,
  });
  const message = messages.find((m) => m.seq === questionSeq && m.role === 'student');
  return message ? message.text : null;
}

/** A `direct` retrieval result → this turn's grounding, snapshot and association. */
function fromDirectResult(
  result: DirectRetrievalResult,
  conversation: TutorConversation,
  ctx: PrepareContext,
  base: FreeChatGrounding,
): FreeChatGrounding {
  const seq = ctx.studentMessage.seq;
  const current = conversation.lessonAssociation;
  if (result.kind === 'insufficient') {
    return {
      ...base,
      grounding: { mode: 'insufficient', reason: result.reason },
      eventReason: result.reason,
      outcomeReason: result.reason,
      resolution: result.resolution,
      embedding: result.embedding ?? null,
    };
  }
  if (result.kind === 'clarify') {
    return {
      ...base,
      outcomeReason: 'clarification',
      resolution: result.resolution,
      clarification: {
        text: clarificationText(ctx.studentMessage.text, result.candidates.map((c) => c.title)),
        candidates: result.candidates,
      },
    };
  }
  const titleOf = new Map(result.items.map((item) => [item.itemId, item] as const));
  const units: DirectSnapshotUnit[] = result.units.map((unit) => ({
    source: 'direct',
    unitId: unit.contentUnitId,
    itemId: unit.learningItemId,
    itemType: unit.itemType,
    buildId: unit.buildId,
    revisionId: unit.contentRevisionId,
    unitUpdatedAt: unit.unitUpdatedAt,
    title: unit.unitTitle,
    text: unit.text,
    chars: unit.text.length,
  }));
  const nextSnapshot: GroundingSnapshot = {
    schema: 2,
    source: 'direct',
    units,
    items: result.items.map((item) => ({ itemId: item.itemId, itemType: item.itemType, title: item.title })),
    keywords: groundingKeywords(result.units.map((unit) => ({ unitTitle: unit.unitTitle, text: unit.text }))),
    setAtSeq: seq,
    lastUsedSeq: seq,
  };
  // Association v2: written for a single-item evidence set; cleared when the
  // evidence spans other items (never left stale).
  let association: FreeChatGrounding['association'] = { kind: 'keep' };
  let associated: ItemAssociationV2 | null = null;
  if (result.items.length === 1) {
    const item = result.items[0]!;
    if (
      current?.schema === 2 &&
      current.learningItemId === item.itemId &&
      current.learningItemType === item.itemType
    ) {
      associated = current;
    } else {
      associated = {
        schema: 2,
        learningItemType: item.itemType,
        learningItemId: item.itemId,
        title: item.title ?? '',
        confidence: Math.max(0, Math.min(1, Math.max(...result.units.map((unit) => unit.similarity)))),
        associatedAtSeq: seq,
        buildId: result.units[0]?.buildId ?? null,
      };
      association = { kind: 'set', value: associated };
    }
  } else if (current) {
    association = { kind: 'clear' };
  }
  const lessonTitle = associated && associated.title ? associated.title : null;
  const itemType = lessonTitle ? associated!.learningItemType : null;
  return {
    ...base,
    grounding: {
      mode: 'retrieved',
      lessonTitle,
      ...(itemType ? { itemType } : {}),
      units: result.units.map((unit) =>
        toGroundingUnitInput({
          unitTitle: unit.unitTitle,
          text: unit.text,
          score: unit.similarity,
          item: {
            key: unit.learningItemId,
            title: titleOf.get(unit.learningItemId)?.title ?? null,
            itemType: unit.itemType,
          },
        }),
      ),
    },
    lessonTitle,
    eventItemType: itemType,
    nextSnapshot,
    association,
    auditUnits: auditUnits(nextSnapshot),
    totalChars: snapshotChars(nextSnapshot),
    resolution: result.resolution,
    embedding: result.embedding,
  };
}

/**
 * The `direct` path (discovery-first §5.6): pending clarification choice →
 * D-10 probe → reuse revalidation (D-17) → retrieve through the reader seam.
 */
async function groundDirect(
  deps: TutorRuntimeDeps,
  direct: DirectGroundingDeps,
  conversation: TutorConversation,
  ctx: PrepareContext,
  assessment: ContextAssessment,
): Promise<FreeChatGrounding> {
  const seq = ctx.studentMessage.seq;
  const scope = {
    tenantId: conversation.tenantId,
    studentRef: conversation.studentRef,
    subjectOfferingId: conversation.subjectOfferingId,
  };
  const clock = new RetrievalClock();
  const snapshot = conversation.grounding;
  const extra: Record<string, unknown> = {};
  const finish = (grounding: FreeChatGrounding): FreeChatGrounding => ({
    ...grounding,
    assessmentExtra: { ...grounding.assessmentExtra, ...extra },
    timings: clock.snapshot(),
  });
  const base = emptyGrounding('direct');

  // 1. A pending clarification: an ordinal or a title chooses the item, and the
  //    ORIGINAL question is retrieved. Anything else is assessed normally.
  const pending = conversation.pendingClarification;
  if (pending && pending.askedAtSeq < seq) {
    const choice = matchClarificationReply(
      ctx.studentMessage.text,
      pending.candidates.map((candidate) => candidate.title),
    );
    if (choice) {
      const candidate = pending.candidates[choice.index]!;
      const question = (await questionText(deps, conversation.id, ctx, pending.questionSeq)) ?? ctx.studentMessage.text;
      extra.clarificationChoice = { by: choice.by, index: choice.index + 1, itemId: candidate.itemId };
      const result = await retrieveDirect(
        direct,
        scope,
        {
          text: question,
          selected: {
            learningItemId: candidate.itemId,
            itemType: candidate.itemType,
            title: candidate.title,
            score: 0,
            matchedTermTypes: [],
            routable: true,
          },
        },
        clock,
      );
      return finish(fromDirectResult(result, conversation, ctx, base));
    }
  }

  // 2. D-10 probe: a strong match to another item upgrades none / reuse to retrieve.
  let decision = assessment.decision;
  let resolved: ResolveItemsResult | undefined;
  if (
    (decision === 'none' || decision === 'reuse') &&
    assessment.rule !== 'social_meta' &&
    assessment.contentKeywordCount >= 1
  ) {
    const currentItems = new Set(
      snapshot?.source === 'direct' && !assessment.groundingStale
        ? snapshot.units.map((unit) => unit.itemId)
        : [],
    );
    const probe = await runDiscoveryProbe(direct, scope, ctx.studentMessage.text, currentItems, clock);
    extra.probe = probe.audit;
    if (probe.upgrade) {
      decision = 'retrieve';
      resolved = probe.upgrade;
    }
  }

  // 3. Reuse: only a `direct` snapshot, revalidated once (D-17).
  if (decision === 'reuse' && snapshot) {
    if (snapshot.source !== 'direct') {
      extra.reuse = 'snapshot_not_direct';
      decision = 'retrieve';
    } else {
      const check = await revalidateUnits(
        direct,
        scope,
        snapshot.units.map((unit) => ({
          contentUnitId: unit.unitId,
          learningItemId: unit.itemId,
          buildId: unit.buildId,
          contentRevisionId: unit.revisionId,
          unitUpdatedAt: unit.unitUpdatedAt,
        })),
        clock,
      );
      extra.revalidation = { outcome: check.outcome, valid: check.validCount, total: snapshot.units.length };
      if (check.outcome === 'valid') {
        return finish(reuseGrounding('direct', snapshot, conversation.lessonAssociation, seq, true));
      }
      if (check.outcome === 'invalid') {
        decision = 'retrieve';
      } else {
        return finish({
          ...base,
          grounding: { mode: 'insufficient', reason: check.outcome },
          eventReason: check.outcome,
          outcomeReason: check.outcome,
        });
      }
    }
  }

  if (decision !== assessment.decision) extra.effectiveDecision = decision;
  if (decision === 'retrieve') {
    const result = await retrieveDirect(direct, scope, { text: ctx.studentMessage.text, resolved }, clock);
    return finish(fromDirectResult(result, conversation, ctx, base));
  }
  return finish(base);
}

export async function prepareFreeChatTurn(
  deps: TutorRuntimeDeps,
  conversation: TutorConversation,
  academic: AcademicBlockInput,
  ctx: PrepareContext,
): Promise<PreparedTurn> {
  const seq = ctx.studentMessage.seq;
  const route = resolveGroundingRoute({
    tenantId: conversation.tenantId,
    directAvailable: deps.grounding !== undefined,
  });
  if (route.fallbackReason === 'reader_not_wired') {
    log.warn(JSON.stringify({ event: 'tutor.grounding_direct_unavailable', turnId: ctx.turnId }));
  }
  const ruleset = assessmentRuleset(route.effective);
  const snapshot = conversation.grounding;
  const turnsSinceUse = snapshot ? Math.max(0, Math.floor((seq - snapshot.lastUsedSeq) / 2)) : 0;
  const assessment: ContextAssessment = assessContext({
    message: ctx.studentMessage.text,
    grounding: snapshot ? { keywords: snapshot.keywords, turnsSinceUse } : null,
    ruleset,
  });

  const outcome =
    route.effective === 'direct'
      ? await groundDirect(deps, deps.grounding!, conversation, ctx, assessment)
      : await groundOverHttp(deps, conversation, ctx, assessment, route.effective);

  const summaryThrough = conversation.summaryThroughSeq;
  const summary = conversation.contextSummary;
  const history = summary && summaryThrough !== null
    ? {
        summary,
        turns: ctx.history.slice(
          ctx.history.length -
            ctx.historyMessages.filter((m) => m.role === 'student' && m.status === 'completed' && m.seq > summaryThrough).length,
        ),
      }
    : { turns: ctx.history };

  const grounded = outcome.grounding.mode === 'reuse' || outcome.grounding.mode === 'retrieved';
  const timings = outcome.timings;
  return {
    academic,
    grounding: outcome.grounding,
    history,
    // The grounding event names the item only for its own evidence this turn (never on insufficient).
    lessonTitle: grounded ? outcome.lessonTitle : null,
    ...(outcome.source === 'direct'
      ? { groundingEvent: { itemType: outcome.eventItemType, reason: outcome.eventReason } }
      : {}),
    ...(outcome.clarification
      ? {
          clarification: {
            text: outcome.clarification.text,
            candidates: outcome.clarification.candidates.map((candidate) => ({
              title: candidate.title,
              itemType: candidate.itemType,
            })),
          },
        }
      : {}),
    audit: {
      assessment: {
        decision: assessment.decision,
        rule: assessment.rule,
        overlap: assessment.overlap,
        groundingStale: assessment.groundingStale,
        keywordCount: assessment.keywords.length,
        ruleset: assessment.ruleset,
        contentKeywordCount: assessment.contentKeywordCount,
        source: outcome.source,
        ...outcome.assessmentExtra,
      },
      units: outcome.auditUnits,
      totalChars: Math.min(outcome.totalChars, UNIT_CHAR_CAP),
      truncated: outcome.truncated,
      retrieval: {
        source: outcome.source,
        outcomeReason: outcome.outcomeReason,
        resolution: outcome.resolution,
        embeddingModel: outcome.embedding?.model ?? null,
        embeddingTokens: outcome.embedding?.tokens ?? null,
        poolWaitMs: timings?.poolWaitMs ?? null,
        resolveMs: timings?.resolveMs ?? null,
        embedMs: timings?.embedMs ?? null,
        searchMs: timings?.searchMs ?? null,
        totalRetrievalMs: timings?.totalRetrievalMs ?? null,
      },
    },
    commit: async (q: Queryable, result) => {
      const nowS = deps.now() / 1000;
      // `direct`: only a delivered turn moves the conversation's grounding, so
      // a retry (turn_attempt + 1) re-runs resolution and retrieval
      // deterministically instead of reusing evidence the student never
      // received. The `kafuo_http` path keeps its existing behaviour.
      if (result.succeeded || outcome.source !== 'direct') {
        if (outcome.nextSnapshot) await writeGroundingSnapshot(q, conversation.id, outcome.nextSnapshot, nowS);
        if (outcome.association.kind === 'set') {
          await updateConversationLessonAssociation(q, conversation.id, outcome.association.value, nowS);
        } else if (outcome.association.kind === 'clear') {
          await updateConversationLessonAssociation(q, conversation.id, null, nowS);
        }
      }
      if (outcome.clarification && result.tutorMessageSeq !== null) {
        await updateConversationPendingClarification(
          q,
          conversation.id,
          { candidates: outcome.clarification.candidates, questionSeq: seq, askedAtSeq: result.tutorMessageSeq },
          nowS,
        );
      } else if (conversation.pendingClarification && result.succeeded) {
        // A choice was consumed, or the student moved on: the question is no longer pending.
        await updateConversationPendingClarification(q, conversation.id, null, nowS);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// After commit: title (awaited, after `done`) and compaction (background)
// ---------------------------------------------------------------------------

async function afterFreeChatTurn(
  deps: TutorRuntimeDeps,
  conversation: TutorConversation,
  policy: ResolvedSubjectPolicy,
  academic: AcademicBlockInput,
  proxyRatio: number | null,
  executorOptions: Parameters<typeof ensureConversationTitle>[0]['executor'],
  info: CommittedTurn,
): Promise<void> {
  if (!info.succeeded || !info.tutorMessage) return;
  // The title is derived from the FIRST completed turn; on a later turn (a
  // pending retry, or a lesson match arriving late) it is read back.
  const isFirstTurn = info.studentMessage.seq === 1;
  const outcome = await ensureConversationTitle({
    pool: deps.pool,
    conversation,
    policy,
    turnId: info.turnId,
    firstTurn: isFirstTurn
      ? { student: info.studentMessage.text, tutor: info.tutorMessage.text }
      : await firstTurnOf(deps, conversation.id),
    academic,
    proxyRatio,
    executor: executorOptions,
    now: deps.now() / 1000,
  });
  if (outcome.changed && outcome.title && !info.sse.closed) info.sse.title(outcome.title);

  if (isCompactionEnabled()) {
    launchBackground(
      compactConversation({
        pool: deps.pool,
        conversationId: conversation.id,
        policy,
        academic,
        turnId: info.turnId,
        proxyRatio,
        executor: executorOptions,
        now: deps.now() / 1000,
      }).catch(() => undefined),
    );
  }
}

async function firstTurnOf(
  deps: TutorRuntimeDeps,
  conversationId: string,
): Promise<{ student: string; tutor: string } | null> {
  const { messages } = await readMessagesBySeq(deps.pool, { parentId: conversationId, beforeSeq: 4, limit: 3 });
  const student = messages.find((m) => m.role === 'student' && m.status === 'completed');
  if (!student) return null;
  const tutor = messages.find((m) => m.role === 'tutor' && m.turnId === student.turnId);
  return tutor ? { student: student.text, tutor: tutor.text } : null;
}

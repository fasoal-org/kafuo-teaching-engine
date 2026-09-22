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
 * Chat `prepare` (assessment → reuse / retrieve / none, snapshot, lesson
 * association) and `afterCommit` (title, optional compaction).
 */
import { randomUUID } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import {
  archiveConversation,
  insertConversationIdempotent,
  listConversationsByStudent,
  readConversationByClientRequestId,
  readMessagesBySeq,
  readOwnedConversation,
  unarchiveConversation,
  updateConversationLessonAssociation,
  writeGroundingSnapshot,
  type ConversationAcademic,
  type ConversationStatus,
  type GroundingSnapshot,
  type GroundingSnapshotUnit,
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
import type { GroundingSearchResponse } from '@/lib/server/tutor/kafuo-integration-client';
import type { AcademicBlockInput, GroundingInput } from '@/lib/server/tutor/prompt-assembly';
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
      ? { lessonTitle: c.lessonAssociation.lessonTitle, confidence: c.lessonAssociation.confidence }
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
// Free Chat prepare: assessment → reuse / retrieve / none
// ---------------------------------------------------------------------------

function snapshotUnitsToInput(units: GroundingSnapshotUnit[]) {
  return units.map((unit) => toGroundingUnitInput({ title: unit.title, text: unit.text }));
}

function auditUnits(units: ReadonlyArray<{ unitId: string; lessonId?: string | null; title: string | null; chars: number }>): TurnGroundingUnit[] {
  return units.map((unit, index) => ({
    unitId: unit.unitId,
    lessonId: unit.lessonId ?? null,
    title: unit.title,
    chars: unit.chars,
    orderIndex: index,
  }));
}

export async function prepareFreeChatTurn(
  deps: TutorRuntimeDeps,
  conversation: TutorConversation,
  academic: AcademicBlockInput,
  ctx: PrepareContext,
): Promise<PreparedTurn> {
  const seq = ctx.studentMessage.seq;
  const snapshot = conversation.grounding;
  const turnsSinceUse = snapshot ? Math.max(0, Math.floor((seq - snapshot.lastUsedSeq) / 2)) : 0;
  const assessment: ContextAssessment = assessContext({
    message: ctx.studentMessage.text,
    grounding: snapshot ? { keywords: snapshot.keywords, turnsSinceUse } : null,
  });

  let grounding: GroundingInput = { mode: 'none' };
  let nextSnapshot: GroundingSnapshot | null = null;
  let association: ReturnType<typeof decideLessonAssociation> = null;
  let audit: TurnGroundingUnit[] = [];
  let totalChars = 0;
  let truncated = false;
  let lessonTitle: string | null = conversation.lessonAssociation?.lessonTitle ?? null;
  let retrieval: 'ok' | 'empty' | 'unavailable' | null = null;

  if (assessment.decision === 'reuse' && snapshot) {
    grounding = { mode: 'reuse', lessonTitle, units: snapshotUnitsToInput(snapshot.units) };
    nextSnapshot = { ...snapshot, lastUsedSeq: seq };
    audit = auditUnits(snapshot.units);
    totalChars = snapshot.units.reduce((sum, unit) => sum + unit.chars, 0);
  } else if (assessment.decision === 'retrieve') {
    let response: GroundingSearchResponse | null = null;
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
      retrieval = 'unavailable';
      log.warn(
        JSON.stringify({
          event: 'tutor.grounding_unavailable',
          turnId: ctx.turnId,
          error: describeErrorSafely(error).name,
        }),
      );
    }
    if (response && response.units.length > 0) {
      retrieval = 'ok';
      association = decideLessonAssociation(response);
      if (association) lessonTitle = association.lessonTitle;
      const units: GroundingSnapshotUnit[] = response.units.map((unit) => ({
        unitId: unit.contentUnitId,
        lessonId: unit.lessonId || null,
        lessonTitle: unit.lessonTitle || null,
        title: unit.unitTitle || null,
        text: unit.text,
        chars: unit.text.length,
      }));
      grounding = {
        mode: 'retrieved',
        lessonTitle: association ? association.lessonTitle : lessonTitle,
        units: response.units.map((unit) =>
          toGroundingUnitInput({ unitTitle: unit.unitTitle, text: unit.text, score: unit.score }),
        ),
      };
      nextSnapshot = { units, keywords: groundingKeywords(response.units), setAtSeq: seq, lastUsedSeq: seq };
      audit = auditUnits(units);
      totalChars = units.reduce((sum, unit) => sum + unit.chars, 0);
      truncated = response.truncated;
    } else {
      if (retrieval === null) retrieval = 'empty';
      grounding = { mode: 'insufficient' };
    }
  }

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

  return {
    academic,
    grounding,
    history,
    // The grounding event names the lesson only when lesson grounding is in play this turn.
    lessonTitle: grounding.mode === 'reuse' || grounding.mode === 'retrieved' ? lessonTitle : null,
    audit: {
      assessment: {
        decision: assessment.decision,
        rule: assessment.rule,
        overlap: assessment.overlap,
        groundingStale: assessment.groundingStale,
        keywordCount: assessment.keywords.length,
        ...(retrieval ? { retrieval } : {}),
        ...(association ? { lessonMatchConfidence: association.confidence } : {}),
      },
      units: audit,
      totalChars: Math.min(totalChars, UNIT_CHAR_CAP),
      truncated,
    },
    commit: async (q: Queryable) => {
      const nowS = deps.now() / 1000;
      if (nextSnapshot) await writeGroundingSnapshot(q, conversation.id, nextSnapshot, nowS);
      if (association && conversation.lessonAssociation?.learningItemId !== association.lessonId) {
        await updateConversationLessonAssociation(
          q,
          conversation.id,
          {
            learningItemType: 'lesson',
            learningItemId: association.lessonId,
            lessonTitle: association.lessonTitle,
            confidence: association.confidence,
            associatedAtSeq: seq,
          },
          nowS,
        );
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

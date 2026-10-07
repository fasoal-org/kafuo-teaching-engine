/**
 * Backend-originated legacy Help model turn (Kafuo R1 contracts §3.4, §10;
 * plan §6.3, §8.8, P6).
 *
 * Kafuo Backend keeps the card-lesson conversation, ownership, replay,
 * grounding selection and in-process metering; ONLY the model boundary moves
 * here. This service therefore:
 *   - validates the body (units ≤ 10,000 chars → GROUNDING_TOO_LARGE, ≤ 40
 *     history entries, `subject.code` in the policy → SUBJECT_ROUTE_UNAVAILABLE,
 *     `requestDigest` recomputed with the Backend's canonical form),
 *   - is idempotent on `turnId` + digest through `legacy_help_turns`
 *     (replay → stored result; `generating` younger than the deadline →
 *     TURN_IN_PROGRESS + Retry-After; other digest → TURN_DIGEST_CONFLICT),
 *   - runs the SAME experiment guard, assembler, budget, executor and
 *     two-write ledger protocol as the Free Chat path with
 *     `capability='help'`, `origin='kafuo_backend'`, stage `help-turn` or
 *     `help-card` by `helpScope.kind`,
 *   - NEVER calls Kafuo (no reserve, no finalize, no grounding search): the
 *     Backend meters in-process. Nothing here imports the integration client.
 */
import { createLogger } from '@/lib/logger';
import {
  beginLegacyHelpTurn,
  completeLegacyHelpTurn,
  deleteExpiredLegacyHelpTurns,
  failLegacyHelpTurn,
  retakeLegacyHelpTurn,
  type LegacyHelpTurnRow,
} from '@/lib/persistence/legacy-help-turns';
import { readCalibration } from '@/lib/persistence/teaching-model-attempts';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  executeTeachingCall,
  type TeachingCallOptions,
  type TeachingCallResult,
} from '@/lib/server/teaching-model/execute';
import { resolveSubjectModelPolicy } from '@/lib/server/teaching-model/resolve-policy';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import { registerRetentionSweep } from '@/lib/server/teaching-model/sweep-registry';
import { detectScript } from '@/lib/server/tutor/arabic-text';
import { computeHelpTurnDigest } from '@/lib/server/tutor/canonical-json';
import {
  boundaryMessage,
  guardOrBoundary,
  postCheck,
  preCheck,
  safetyRecord,
  type SafetyRecord,
} from '@/lib/server/tutor/experiment-guard';
import { readVersionScene, type LearnerSceneDeps } from '@/lib/server/teaching-package/learner-scene';
import {
  assembleTutorPrompt,
  isHelpIntentHint,
  type AcademicBlockInput,
  type GroundingInput,
  type HelpIntentHint,
  type HistoryTurnInput,
} from '@/lib/server/tutor/prompt-assembly';
import { parseAcademic, parseLearnerSubject, parseLocaleHint, parseStudentRef } from '@/lib/server/tutor/student-context';
import { resolveProxyRatio, UNIT_CHAR_CAP } from '@/lib/server/tutor/token-budget';
import { TURN_IN_PROGRESS_WINDOW_S, classifyTurnFailure } from '@/lib/server/tutor/turn-runner';

const log = createLogger('LegacyHelpTurns');

export const LEGACY_HELP_MAX_HISTORY = 40;
export const LEGACY_HELP_MAX_MESSAGE_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Request parsing (contracts §3.4)
// ---------------------------------------------------------------------------

export interface LegacyHelpUnit {
  unitId: string;
  title: string | null;
  text: string;
  charLength: number;
}

export interface LegacyHelpTurnRequest {
  tenantId: string;
  turnId: string;
  requestDigest: string;
  studentRef: string;
  /** `code` null = the lesson's master subject has no routing key (refused as unrouted). */
  subject: { code: string | null; nameAr: string | null; nameEn: string | null; academicLanguage: string };
  academic: { curriculumName: string | null; curriculumVersionLabel: string | null; gradeLabel: string | null };
  lesson: { learningItemType: string; learningItemId: string; title: string } | null;
  helpScope: {
    kind: 'help_linked_chat' | 'help_card';
    label: string | null;
    cardKey: string | null;
    stepNumber: number | null;
    intent: string | null;
    /** The runner's committed slide (slides mode): the pinned version and its Scene id. */
    slide: { versionId: string; sceneId: string } | null;
    intentHint: HelpIntentHint | null;
  };
  grounding: { units: LegacyHelpUnit[]; truncated: boolean };
  history: HistoryTurnInput[];
  message: string;
  localeHint: string | null;
  legacyHelpLinkRef: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): TeachingPackageError {
  return new TeachingPackageError('INVALID_REQUEST', message);
}

function optionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`${where} must be a string`);
  return value;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${where} must be a non-empty string`);
  return value;
}

export function parseLegacyHelpTurnRequest(body: Record<string, unknown>): LegacyHelpTurnRequest {
  const tenantContext = body.tenantContext;
  if (!isRecord(tenantContext)) throw new TeachingPackageError('TENANT_REQUIRED', 'tenantContext.tenantId is required');
  const tenantId = requireString(tenantContext.tenantId, 'tenantContext.tenantId');
  if (body.origin !== 'kafuo_backend') throw invalid("origin must be 'kafuo_backend'");
  if (typeof body.actorRef !== 'string') throw new TeachingPackageError('ACTOR_REQUIRED', 'actorRef must be a string');
  const turnId = requireString(body.turnId, 'turnId');
  if (turnId.length > 200) throw invalid('turnId must be at most 200 chars');
  const requestDigest = requireString(body.requestDigest, 'requestDigest').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) throw invalid('requestDigest must be a sha256 hex digest');
  const studentRef = parseStudentRef(body.studentRef);
  const subject = parseLearnerSubject(body.subject);
  const academic = parseAcademic(body.academic, { requireCurriculumId: false });

  let lesson: LegacyHelpTurnRequest['lesson'] = null;
  if (body.lesson !== undefined && body.lesson !== null) {
    if (!isRecord(body.lesson)) throw invalid('lesson must be an object');
    lesson = {
      learningItemType: requireString(body.lesson.learningItemType, 'lesson.learningItemType'),
      learningItemId: requireString(body.lesson.learningItemId, 'lesson.learningItemId'),
      title: optionalString(body.lesson.title, 'lesson.title') ?? '',
    };
  }

  if (!isRecord(body.helpScope)) throw invalid('helpScope must be an object');
  const kind = body.helpScope.kind;
  if (kind !== 'help_linked_chat' && kind !== 'help_card') {
    throw invalid("helpScope.kind must be 'help_linked_chat' or 'help_card'");
  }
  const stepNumber = body.helpScope.stepNumber;
  if (stepNumber !== undefined && stepNumber !== null && typeof stepNumber !== 'number') {
    throw invalid('helpScope.stepNumber must be a number');
  }
  let slide: LegacyHelpTurnRequest['helpScope']['slide'] = null;
  if (body.helpScope.slide !== undefined && body.helpScope.slide !== null) {
    if (!isRecord(body.helpScope.slide)) throw invalid('helpScope.slide must be an object');
    slide = {
      versionId: requireString(body.helpScope.slide.versionId, 'helpScope.slide.versionId'),
      sceneId: requireString(body.helpScope.slide.sceneId, 'helpScope.slide.sceneId'),
    };
  }
  const intentHint = body.helpScope.intentHint;
  if (intentHint !== undefined && intentHint !== null && !isHelpIntentHint(intentHint)) {
    throw invalid('helpScope.intentHint must be one of explain, simplify, hint, check_answer');
  }
  const helpScope: LegacyHelpTurnRequest['helpScope'] = {
    kind,
    label: optionalString(body.helpScope.label, 'helpScope.label'),
    cardKey: optionalString(body.helpScope.cardKey, 'helpScope.cardKey'),
    stepNumber: typeof stepNumber === 'number' ? stepNumber : null,
    intent: optionalString(body.helpScope.intent, 'helpScope.intent'),
    slide,
    intentHint: isHelpIntentHint(intentHint) ? intentHint : null,
  };

  if (!isRecord(body.grounding) || !Array.isArray(body.grounding.units)) {
    throw invalid('grounding.units must be an array');
  }
  const units: LegacyHelpUnit[] = body.grounding.units.map((entry, index) => {
    if (!isRecord(entry)) throw invalid(`grounding.units[${index}] must be an object`);
    const text = requireString(entry.text, `grounding.units[${index}].text`);
    return {
      unitId: requireString(entry.unitId, `grounding.units[${index}].unitId`),
      title: optionalString(entry.title, `grounding.units[${index}].title`),
      text,
      charLength: typeof entry.charLength === 'number' ? entry.charLength : text.length,
    };
  });
  const totalChars = units.reduce((sum, unit) => sum + unit.text.length, 0);
  if (totalChars > UNIT_CHAR_CAP) {
    throw new TeachingPackageError(
      'GROUNDING_TOO_LARGE',
      `grounding units total ${totalChars} chars; the ceiling is ${UNIT_CHAR_CAP}`,
      { totalChars, cap: UNIT_CHAR_CAP },
    );
  }

  if (!Array.isArray(body.history)) throw invalid('history must be an array');
  if (body.history.length > LEGACY_HELP_MAX_HISTORY) {
    throw invalid(`history must have at most ${LEGACY_HELP_MAX_HISTORY} entries`);
  }
  const history: HistoryTurnInput[] = [];
  for (const [index, entry] of body.history.entries()) {
    if (!isRecord(entry) || (entry.role !== 'student' && entry.role !== 'tutor')) {
      throw invalid(`history[${index}].role must be 'student' or 'tutor'`);
    }
    const text = requireString(entry.text, `history[${index}].text`);
    const last = history[history.length - 1];
    if (entry.role === 'student') history.push({ student: text, tutor: null });
    else if (last && last.tutor === null) last.tutor = text;
    else history.push({ student: '', tutor: text });
  }

  if (!isRecord(body.message)) throw invalid('message must be an object');
  const message = requireString(body.message.text, 'message.text');
  if (message.length > LEGACY_HELP_MAX_MESSAGE_CHARS) {
    throw new TeachingPackageError('REQUEST_TOO_LARGE', `message.text must be at most ${LEGACY_HELP_MAX_MESSAGE_CHARS} chars`);
  }

  return {
    tenantId,
    turnId,
    requestDigest,
    studentRef,
    subject,
    academic,
    lesson,
    helpScope,
    grounding: { units, truncated: body.grounding.truncated === true },
    history: history.filter((turn) => turn.student !== '' || turn.tutor !== null),
    message,
    localeHint: parseLocaleHint(body.localeHint) ?? null,
    legacyHelpLinkRef: optionalString(body.legacyHelpLinkRef, 'legacyHelpLinkRef'),
  };
}

/** `kafuo:conv:{id}:{clientMessageId}` → `kafuo:{id}` (plan §5.1); other keys → null. */
export function originConversationRefOf(turnId: string): string | null {
  const match = /^kafuo:conv:([^:]+):/.exec(turnId);
  return match ? `kafuo:${match[1]}` : null;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface LegacyHelpTurnResponse {
  text: string;
  servedBy: 'primary' | 'fallback';
  safety: SafetyRecord | Record<string, unknown>;
  groundingMode: 'scene' | 'insufficient';
  attemptIds: string[];
  accountingComplete: true;
  budget: { estimate: number; counterKind: 'exact' | 'proxy' };
}

function responseOf(row: LegacyHelpTurnRow): LegacyHelpTurnResponse {
  return {
    text: row.text ?? '',
    servedBy: row.servedBy ?? 'primary',
    safety: row.safety ?? { triggered: false },
    groundingMode: row.groundingMode ?? 'insufficient',
    attemptIds: row.attemptIds,
    accountingComplete: true,
    budget: row.budget ?? { estimate: 0, counterKind: 'exact' },
  };
}

export interface LegacyHelpDeps {
  queryable: TeachingCallOptions['queryable'] & { query(text: string, params?: unknown[]): Promise<unknown> };
  now?: () => number;
  workerId?: string;
  executor?: Pick<TeachingCallOptions, 'rateCard' | 'proxyRatioReader' | 'completionRetryDelaysMs' | 'timeoutMs' | 'idFactory'>;
  inProgressWindowS?: number;
  /** Test seam; defaults to `readVersionScene` over the teaching-package document store. */
  loadSlide?: (input: {
    tenantId: string;
    versionId: string;
    sceneId: string;
  }) => Promise<{ sceneTitle: string; sceneText: string } | null>;
}

/**
 * The slide the student is on, as scene grounding. A miss never fails the card: the card
 * is still answered from the request's own units, exactly as before the slide was sent.
 */
async function resolveSlide(
  request: LegacyHelpTurnRequest,
  deps: LegacyHelpDeps,
): Promise<{ sceneTitle: string; sceneText: string } | null> {
  const slide = request.helpScope.slide;
  if (!slide) return null;
  const input = { tenantId: request.tenantId, versionId: slide.versionId, sceneId: slide.sceneId };
  try {
    if (deps.loadSlide) return await deps.loadSlide(input);
    const scene = await readVersionScene({ pool: deps.queryable as unknown as LearnerSceneDeps['pool'] }, input);
    return { sceneTitle: scene.sceneTitle, sceneText: scene.sceneText };
  } catch (error) {
    log.warn(
      JSON.stringify({ event: 'legacy_help.slide_unavailable', turnId: request.turnId, sceneId: slide.sceneId }),
      describeErrorSafely(error),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runLegacyHelpTurn(
  body: Record<string, unknown>,
  deps: LegacyHelpDeps,
): Promise<LegacyHelpTurnResponse> {
  const now = deps.now ?? Date.now;
  const nowS = () => now() / 1000;
  const windowS = deps.inProgressWindowS ?? TURN_IN_PROGRESS_WINDOW_S;
  const queryable = deps.queryable!;

  const request = parseLegacyHelpTurnRequest(body);
  const digest = computeHelpTurnDigest(body);
  if (digest !== request.requestDigest) {
    throw new TeachingPackageError('INVALID_REQUEST', 'requestDigest does not match the canonical request', {
      expected: digest,
    });
  }
  if (request.subject.code === null || !isSubjectCode(request.subject.code)) {
    throw new TeachingPackageError(
      'SUBJECT_ROUTE_UNAVAILABLE',
      `subject ${request.subject.code ?? '(none)'} is not in the routing policy`,
      { subjectCode: request.subject.code },
    );
  }
  const policy = await resolveSubjectModelPolicy(request.subject.code);

  // --- idempotency on turnId + digest ------------------------------------------
  const begun = await beginLegacyHelpTurn(queryable, {
    turnId: request.turnId,
    tenantId: request.tenantId,
    studentRef: request.studentRef,
    originConversationRef: originConversationRefOf(request.turnId),
    requestDigest: digest,
    now: nowS(),
  });
  if (!begun.inserted) {
    const existing = begun.row;
    if (existing.requestDigest !== digest) {
      throw new TeachingPackageError('TURN_DIGEST_CONFLICT', 'turnId was already used with a different request');
    }
    if (existing.status === 'completed') return responseOf(existing);
    if (existing.status === 'generating' && nowS() - existing.generatingAt < windowS) {
      throw new TeachingPackageError('TURN_IN_PROGRESS', 'this turn is still generating', {
        retryAfterS: Math.max(1, Math.ceil(windowS - (nowS() - existing.generatingAt))),
      });
    }
    const retaken = await retakeLegacyHelpTurn(queryable, request.turnId, {
      now: nowS(),
      staleBefore: nowS() - windowS,
    });
    if (!retaken) {
      throw new TeachingPackageError('TURN_IN_PROGRESS', 'this turn is being generated', { retryAfterS: windowS });
    }
  }

  const fail = async (code: string, attemptIds: string[] = []) => {
    await failLegacyHelpTurn(queryable, request.turnId, { errorCode: code, attemptIds, now: nowS() }).catch(
      (error) => log.error('legacy help turn fail-mark failed:', describeErrorSafely(error)),
    );
  };

  // --- guard pre-check ----------------------------------------------------------
  // The boundary in the student's language (FC-D13): script → locale hint → academic language.
  const boundary = boundaryMessage(
    detectScript(request.message),
    request.localeHint,
    request.subject.academicLanguage,
  );
  const pre = guardOrBoundary(() => preCheck(request.message), boundary);
  if (!pre.ok) {
    const safety = safetyRecord({ triggered: true, categories: [], directive: null }, { applied: true, reason: 'guard_error' });
    const stored = await completeLegacyHelpTurn(queryable, request.turnId, {
      text: pre.boundary,
      servedBy: 'primary',
      safety: safety as unknown as Record<string, unknown>,
      groundingMode: request.grounding.units.length ? 'scene' : 'insufficient',
      attemptIds: [],
      budget: { estimate: 0, counterKind: policy.primary.counterKind },
      now: nowS(),
    });
    return stored ? responseOf(stored) : { ...responseOf(begun.row), text: pre.boundary, safety };
  }
  const safetyPre = pre.value;

  // --- assemble under the tighter cap ----------------------------------------
  const academic: AcademicBlockInput = {
    subjectNameAr: request.subject.nameAr,
    subjectNameEn: request.subject.nameEn,
    curriculumName: request.academic.curriculumName,
    curriculumVersionLabel: request.academic.curriculumVersionLabel,
    gradeLabel: request.academic.gradeLabel,
    academicLanguage: request.subject.academicLanguage,
  };
  const sceneTitle = request.lesson?.title || request.helpScope.label || null;
  const slide = await resolveSlide(request, deps);
  const units = request.grounding.units.map((unit) => ({
    title: unit.title,
    text: unit.text,
    ...(request.grounding.truncated ? { truncated: true } : {}),
  }));
  const grounding: GroundingInput = slide && slide.sceneText.trim()
    ? {
        // The runner's committed slide is what the student is looking at: its visible text
        // anchors the card, and the request's units (if any) stay the fact source behind it.
        mode: 'scene',
        sceneTitle: slide.sceneTitle || request.helpScope.label || sceneTitle,
        sceneText: slide.sceneText,
        units,
      }
    : request.grounding.units.length === 0
      ? { mode: 'insufficient' }
      : {
          mode: 'scene',
          sceneTitle,
          units: request.grounding.units.map((unit) => ({
            title: unit.title,
            text: unit.text,
            ...(request.grounding.truncated ? { truncated: true } : {}),
          })),
        };
  const proxyTarget = [policy.primary, policy.fallback].find((t) => t.counterKind === 'proxy');
  const proxyRatio = proxyTarget
    ? await resolveProxyRatio(
        proxyTarget.modelString,
        deps.executor?.proxyRatioReader ??
          (async (modelString) => (await readCalibration(queryable, modelString))?.proxyRatio ?? null),
      )
    : null;
  let assembled: ReturnType<typeof assembleTutorPrompt>;
  try {
    assembled = assembleTutorPrompt({
      academic,
      grounding,
      history: { turns: request.history },
      message: request.message,
      policy,
      counters: { proxyRatio },
      directives: {
        responseScript: detectScript(request.message),
        localeHint: request.localeHint,
        safetyTriggered: safetyPre.triggered,
        intentHint: request.helpScope.intentHint,
      },
      helpMode: true,
    });
  } catch (error) {
    if (error instanceof TeachingPackageError) await fail(error.code);
    throw error;
  }
  const groundingMode: 'scene' | 'insufficient' = assembled.groundingMode === 'scene' ? 'scene' : 'insufficient';

  // --- executor (started row → call → completion, direct writes) ------------
  let result: TeachingCallResult;
  try {
    result = await executeTeachingCall(
      policy,
      {
        tenantId: request.tenantId,
        capability: 'help',
        stage: request.helpScope.kind === 'help_card' ? 'help-card' : 'help-turn',
        origin: 'kafuo_backend',
        association: {
          kind: 'turn',
          turnId: request.turnId,
          conversationId: originConversationRefOf(request.turnId),
          studentRef: request.studentRef,
          learningItemType: request.lesson?.learningItemType ?? null,
          learningItemId: request.lesson?.learningItemId ?? null,
          legacyHelpLinkRef: request.legacyHelpLinkRef,
        },
        budget: {
          estimate: assembled.budget.estimate,
          counterKind: assembled.budget.counterKind,
          effectiveCap: assembled.budget.effectiveCap,
        },
      },
      { messages: assembled.messages },
      { queryable, now, workerId: deps.workerId, ...(deps.executor ?? {}) },
    );
  } catch (error) {
    const failure = classifyTurnFailure(error);
    const attemptIds = (error as { attemptIds?: string[] }).attemptIds ?? [];
    await fail(failure.code, attemptIds);
    if (error instanceof TeachingPackageError) throw error;
    const code =
      failure.code === 'TEACHING_MODEL_UNAVAILABLE' ||
      failure.code === 'ACCOUNTING_UNAVAILABLE' ||
      failure.code === 'BUDGET_ASSERTION_FAILED'
        ? failure.code
        : 'TEACHING_MODEL_UNAVAILABLE';
    throw new TeachingPackageError(code, `legacy help turn failed: ${failure.code}`, {
      retryable: failure.retryable,
      attemptIds,
    });
  }

  // --- post-check → boundary ------------------------------------------------------
  let text = result.text;
  let safety = safetyRecord(safetyPre, { applied: false });
  const post = guardOrBoundary(() => postCheck(text, { preTriggered: safetyPre.triggered }), boundary);
  if (!post.ok || post.value.violation) {
    text = boundary;
    safety = safetyRecord(safetyPre, {
      applied: true,
      reason: post.ok ? (post.value.rule ?? 'operational_sequence') : 'guard_error',
    });
    log.info(JSON.stringify({ event: 'tutor.safety_triggered', turnId: request.turnId, boundary: true, reason: safety.reason }));
  }

  const stored = await completeLegacyHelpTurn(queryable, request.turnId, {
    text,
    servedBy: result.servedBy,
    safety: safety as unknown as Record<string, unknown>,
    groundingMode,
    attemptIds: result.attemptIds,
    budget: { estimate: assembled.budget.estimate, counterKind: assembled.budget.counterKind },
    now: nowS(),
  });
  log.info(
    JSON.stringify({
      event: 'tutor.turn',
      turnId: request.turnId,
      capability: 'help',
      origin: 'kafuo_backend',
      stage: request.helpScope.kind === 'help_card' ? 'help-card' : 'help-turn',
      groundingMode,
      groundingChars: assembled.grounding.totalChars,
      tokenEstimate: assembled.budget.estimate,
      counterKind: assembled.budget.counterKind,
      reductions: assembled.reductions,
      servedBy: result.servedBy,
      outcome: safety.boundary ? 'SAFETY_BOUNDARY' : 'completed',
      totalMs: result.timings.totalMs,
    }),
  );
  return stored
    ? responseOf(stored)
    : {
        text,
        servedBy: result.servedBy,
        safety,
        groundingMode,
        attemptIds: result.attemptIds,
        accountingComplete: true,
        budget: { estimate: assembled.budget.estimate, counterKind: assembled.budget.counterKind },
      };
}

/** Register the 7-day retention pass with the accounting sweeper (boot). */
export function registerLegacyHelpRetention(): void {
  registerRetentionSweep('legacy_help_turns', (queryable, nowS) =>
    deleteExpiredLegacyHelpTurns(queryable as Parameters<typeof deleteExpiredLegacyHelpTurns>[0], nowS),
  );
}

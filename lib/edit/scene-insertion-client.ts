/**
 * Browser side of a reviewer-generated slide for an uncovered lesson part
 * (reviewer-generated-slide-for-lesson-part-plan §5.1).
 *
 *    1 preconditions   → gate allows, nothing running, no regeneration held here
 *    2 lock            → beginStageInsertion + the Stage-wide editing lock
 *    3 drain           → registered direct saves, then the scheduler flush
 *    4 prove           → isStageDocumentDurable (a resolved drain is NOT proof)
 *    5 hold            → no flush round starts; direct saves are deferred
 *    6 re-prove        → synchronous, right after the hold
 *    7 baseline        → the mark + the bound revisions
 *    8 admit + settle  → read the server clock; every POST carries ONE
 *                        server-time admission deadline (T1 refuses a run
 *                        after it); retry the same key and body only inside
 *                        that window; settle by id, else by key under the
 *                        Stage lock; hold until a definite answer or until
 *                        no run this request started can still commit
 *    9 fetch, then apply synchronously → loadStageData is the LAST await;
 *                        applyInsertionResult re-checks the handle and the dirt
 *                        present at that moment (clean apply or local-wins merge)
 *   10 release         → in `finally`, after the apply returned
 *
 * The insertion never calls `resyncStageScenesFromServer`: it awaits its read
 * and then replaces Scenes without a dirt check. `reason` is an audit field
 * the server stores; neither text is ever applied locally.
 */
import {
  applyInsertionResult,
  beginStageInsertion,
  drainStageDocumentWrites,
  isStageDocumentDurable,
  isStageWritesHeld,
  onStageSaveConflict,
  pendingStageDocumentKeys,
  type InsertionApplyOutcome,
} from '@/lib/store/stage';
import { loadStageData } from '@/lib/utils/stage-storage';
import type { Scene } from '@/lib/types/stage';

/** Field limits, trimmed — mirrored by the server's request parser. */
export const SCENE_INSERTION_LIMITS = {
  units: { min: 1, max: 3 },
  instruction: { min: 0, max: 2000 },
  reason: { min: 5, max: 1000 },
} as const;

export interface TeachingStageRef {
  key: string;
  flowIndex: number;
}

export interface InsertionGate {
  capability: 'read' | 'write';
  editable: boolean;
  versionStatus: string | null;
  supported: boolean;
  unsupportedReason: 'no_flow' | 'legacy_successor' | 'no_content_units' | null;
  running: Array<{ kind: 'insertion' | 'regeneration'; id: string; sceneId?: string }>;
  /** The server clock when the gate was read (server time, ms). */
  serverNow?: number;
}

export interface ContentUnitSummary {
  id: string;
  order: number;
  title: string | null;
  role: string;
  instructional: boolean;
  textLength: number;
  coveredBySlideIds: string[];
  citedByOtherSceneIds: string[];
  covered: boolean;
  /** Where a slide for this unit goes by default (plan §9.1); instructional uncovered units only. */
  suggestedPosition: InsertionPosition | null;
}

export interface InsertionPosition {
  afterSceneId: string | null;
  beforeSceneId: string | null;
}

export interface InsertionPositionOption extends InsertionPosition {
  /** The `(key, flowIndex)` stages a new slide may take here (plan §9.2); empty = refused. */
  allowedStages: TeachingStageRef[];
}

export interface ContentUnitsResponse {
  lineageStatus: 'own_attempt' | 'predecessor_attempt' | 'unavailable';
  units: ContentUnitSummary[];
  /** One entry per gap, from before the first Scene to after the last. */
  positions: InsertionPositionOption[];
  /** Display labels of the flow positions, by `flowIndex`. */
  stages: Array<TeachingStageRef & { label: string }>;
}

export interface SceneInsertionStatus {
  insertionId: string;
  status: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  newSceneId: string;
  resultSceneRev: number | null;
  scene: Scene | null;
  revTransitions: Record<string, { before: number; after: number }> | null;
  requestedAt: number;
  completedAt: number | null;
  /** Running rows: the lease time left, measured on the server (informational). */
  leaseRemainingMs?: number | null;
}

export class SceneInsertionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SceneInsertionRequestError';
  }
}

async function errorFrom(response: Response): Promise<SceneInsertionRequestError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  return new SceneInsertionRequestError(
    response.status,
    body?.error?.code ?? (response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR'),
    body?.error?.message ?? `the request failed (HTTP ${response.status})`,
    body?.error?.details,
  );
}

const stagePath = (stageId: string) => `/api/stages/${encodeURIComponent(stageId)}`;

/** One read (gate, status); a stalled connection is cut so every loop keeps its bound. */
const STATUS_READ_TIMEOUT_MS = 30_000;

function timeoutSignal(ms: number): { signal?: AbortSignal } {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? { signal: AbortSignal.timeout(ms) }
    : {};
}

/** The gate for a Stage, or `null` when this tab holds no grant for it. */
export async function fetchInsertionGate(
  stageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InsertionGate | null> {
  const response = await fetchImpl(`${stagePath(stageId)}/scene-insertion`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...timeoutSignal(STATUS_READ_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.json()) as InsertionGate;
}

export function canInsertScene(gate: InsertionGate | null): boolean {
  return gate !== null && gate.capability === 'write' && gate.editable && gate.supported;
}

/** The lesson parts and their coverage (no unit text ever reaches the browser). */
export async function fetchContentUnits(
  stageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentUnitsResponse> {
  const response = await fetchImpl(`${stagePath(stageId)}/content-units`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as ContentUnitsResponse;
}

export function newInsertionKey(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `insert-${random}`.replace(/[^A-Za-z0-9_-]/g, '');
}

export interface SceneInsertionRequest extends InsertionPosition {
  unitIds: string[];
  teachingStage: TeachingStageRef;
  instruction: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * The admission window, counted from the server clock read right before the
 * first POST. Every POST of a run carries `admitBy` = that reading + this
 * window, and the server starts a run only before it (T1 checks it under the
 * Stage lock, with the clock read after the lock). It is also the POST retry
 * budget: a later POST could only replay.
 */
export const INSERTION_ADMISSION_WINDOW_MS = 2 * 60 * 1000;
/** The server's longest lease (`MAX_SCENE_INSERTION_LEASE_SECONDS`, pinned by a test). */
export const INSERTION_MAX_LEASE_MS = 1080 * 1000;
/** Past the last possible lease end: the commit statement itself, and clock rate. */
export const INSERTION_RELEASE_GRACE_MS = 2 * 60 * 1000;
/**
 * An absent key proves "no run can start" only this far past `admitBy`
 * (server time): slack for a TE clock that was stepped back or differs
 * between the read and a T1 still queued on the lock.
 */
export const INSERTION_CLOCK_MARGIN_MS = 30 * 1000;
/** One POST attempt (it waits for the whole run); the server ignores a disconnect. */
const POST_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

const INSERTION_STATES = new Set(['running', 'succeeded', 'failed']);

/** A status body as the TE writes it, or `null` (cut, malformed, or not the TE's). */
function statusFrom(value: unknown): SceneInsertionStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = value as Partial<SceneInsertionStatus>;
  if (typeof status.insertionId !== 'string' || status.insertionId === '') return null;
  if (typeof status.status !== 'string' || !INSERTION_STATES.has(status.status)) return null;
  if (
    status.status === 'succeeded' &&
    (typeof status.newSceneId !== 'string' || status.newSceneId === '')
  ) {
    return null;
  }
  return status as SceneInsertionStatus;
}

/** The TE's error envelope, or `null` (a gateway's page, or a cut body). */
function envelopeFrom(value: unknown): { code: string; message: string; details?: unknown } | null {
  const error = (value as { error?: { code?: unknown; message?: unknown; details?: unknown } })
    ?.error;
  if (!error || typeof error.code !== 'string' || error.code === '') return null;
  return {
    code: error.code,
    message:
      typeof error.message === 'string' ? error.message : `the request failed (${error.code})`,
    details: error.details,
  };
}

/** The body as JSON; `undefined` when it could not be read to the end or parsed. */
async function jsonFrom(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  try {
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

type PostAnswer =
  /** The TE's answer about this key: `200` (an outcome) or `202` (running). */
  | { kind: 'status'; status: SceneInsertionStatus }
  /** A definite refusal of THIS request: it was answered without a run. */
  | { kind: 'refused'; error: SceneInsertionRequestError }
  /** Nothing says what happened (transport, cut or malformed body, gateway, TE-internal). */
  | { kind: 'ambiguous' };

/** Without a TE envelope these 4xx are a gateway's or a rate limiter's, not an answer. */
const AMBIGUOUS_CLIENT_STATUSES = new Set([408, 429]);

/**
 * One POST. Reading and validating the body is part of the answer: a body cut
 * mid-read, invalid JSON or a success envelope that is not a status are as
 * ambiguous as a dropped connection — the server may be running the request.
 * A coded TE error is definite, except the TE's own unmapped
 * `INTERNAL_ERROR`; without a TE envelope a 5xx, 408 or 429 is a gateway's
 * (ambiguous), while any other 4xx status line consumed the request.
 */
async function postOnce(
  stageId: string,
  body: SceneInsertionRequest & { admitBy: number },
  fetchImpl: typeof fetch,
): Promise<PostAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${stagePath(stageId)}/scene-insertions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...timeoutSignal(POST_ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'ambiguous' };
  }
  const json = await jsonFrom(response);
  if (response.ok) {
    const status =
      response.status === 200 || response.status === 202
        ? statusFrom((json as { insertion?: unknown } | null | undefined)?.insertion)
        : null;
    return status ? { kind: 'status', status } : { kind: 'ambiguous' };
  }
  const envelope = envelopeFrom(json);
  if (envelope && envelope.code !== 'INTERNAL_ERROR') {
    return {
      kind: 'refused',
      error: new SceneInsertionRequestError(
        response.status,
        envelope.code,
        envelope.message,
        envelope.details,
      ),
    };
  }
  // The TE's INTERNAL_ERROR, or no TE envelope on a gateway-like status (its
  // body unreadable or not): ambiguous. Any other 4xx status line, whatever
  // its body, answered this request without a run.
  if (envelope || response.status >= 500 || AMBIGUOUS_CLIENT_STATUSES.has(response.status)) {
    return { kind: 'ambiguous' };
  }
  return {
    kind: 'refused',
    error: new SceneInsertionRequestError(
      response.status,
      response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
      `the request failed (HTTP ${response.status})`,
    ),
  };
}

type KeyAnswer =
  | { kind: 'status'; status: SceneInsertionStatus }
  /** The TE's own 404: no row under this key; `serverNow` was read under the Stage lock. */
  | { kind: 'absent'; serverNow: number | null }
  | { kind: 'unreadable' };

/** The by-key status read: it never creates anything. */
async function readByKey(
  stageId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch,
): Promise<KeyAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${stagePath(stageId)}/scene-insertions?key=${encodeURIComponent(idempotencyKey)}`,
      { credentials: 'same-origin', cache: 'no-store', ...timeoutSignal(STATUS_READ_TIMEOUT_MS) },
    );
  } catch {
    return { kind: 'unreadable' };
  }
  const json = await jsonFrom(response);
  if (response.ok) {
    const status = statusFrom(json);
    return status ? { kind: 'status', status } : { kind: 'unreadable' };
  }
  const envelope = envelopeFrom(json);
  if (response.status === 404 && envelope?.code === 'INSERTION_NOT_FOUND') {
    const serverNow = (envelope.details as { serverNow?: unknown } | undefined)?.serverNow;
    return {
      kind: 'absent',
      serverNow: typeof serverNow === 'number' && Number.isFinite(serverNow) ? serverNow : null,
    };
  }
  return { kind: 'unreadable' };
}

type IdAnswer =
  | { kind: 'status'; status: SceneInsertionStatus }
  /** The TE refused the read itself (scoped 404, or no write grant): this tab cannot write the Stage. */
  | { kind: 'gone' }
  | { kind: 'unreadable' };

async function readById(
  stageId: string,
  insertionId: string,
  fetchImpl: typeof fetch,
): Promise<IdAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${stagePath(stageId)}/scene-insertions/${encodeURIComponent(insertionId)}`,
      { credentials: 'same-origin', cache: 'no-store', ...timeoutSignal(STATUS_READ_TIMEOUT_MS) },
    );
  } catch {
    return { kind: 'unreadable' };
  }
  const json = await jsonFrom(response);
  if (response.ok) {
    const status = statusFrom(json);
    return status && status.insertionId === insertionId
      ? { kind: 'status', status }
      : { kind: 'unreadable' };
  }
  const envelope = envelopeFrom(json);
  // A plain 404 from an edge or a deploy misroute is not the TE's answer.
  if (
    (response.status === 404 && envelope?.code === 'INSERTION_NOT_FOUND') ||
    (response.status === 403 && envelope !== null)
  ) {
    return { kind: 'gone' };
  }
  return { kind: 'unreadable' };
}

/** The server clock, from the gate; `null` when it cannot be read (then nothing is sent). */
async function readServerClock(stageId: string, fetchImpl: typeof fetch): Promise<number | null> {
  try {
    const gate = await fetchInsertionGate(stageId, fetchImpl);
    const serverNow = gate?.serverNow;
    return typeof serverNow === 'number' && Number.isFinite(serverNow) ? serverNow : null;
  } catch {
    return null;
  }
}

export type SceneInsertionOutcome =
  /** Saved and shown: the editor now displays what the database holds, plus any local dirt. */
  | {
      kind: 'success';
      insertionId: string;
      sceneId: string;
      applied: Extract<InsertionApplyOutcome, 'applied' | 'merged'>;
    }
  /**
   * Saved on the server, not applied here: the editor moved on (`stale`), the
   * read could not prove its revisions (`unbound`), or it failed. The next
   * load (or the next save's conflict recovery) shows the new slide.
   */
  | {
      kind: 'saved-not-shown';
      insertionId: string;
      sceneId: string;
      reason: 'stale' | 'unbound' | 'fetch-error';
    }
  /** Something of this Stage is not saved yet: nothing was sent, local edits untouched. */
  | { kind: 'not-durable'; pendingKeys: string[]; conflict: boolean }
  /** Another generation runs (this tab or the gate): nothing was sent. */
  | { kind: 'busy' }
  /** The server refused or failed, and no run of this request can still commit: nothing changed. */
  | { kind: 'failed'; status: number; code: string; message: string; details?: unknown }
  /**
   * The outcome could not be read: keep the key; a retry replays. Returned
   * when nothing was sent, once no run of this request can still commit (the
   * last read past the release bound failed), or when the TE refused the
   * status read itself (its scoped 404, or a 403: this tab's own writes to
   * the Stage are refused then, though the run may still commit).
   */
  | { kind: 'unknown'; insertionId: string | null };

export interface RunSceneInsertionInput {
  stageId: string;
  request: SceneInsertionRequest;
  /** A slide or audio regeneration is in flight in this tab (the nav rail knows). */
  localGenerationRunning: boolean;
  /** The gate's `running` array, as last read. */
  gateRunning?: InsertionGate['running'];
}

export interface RunSceneInsertionDeps {
  fetchImpl?: typeof fetch;
  /** The pause base: POST retries and key reads back off from it; polls wait twice it. */
  pollIntervalMs?: number;
  /** Test seam: the read of step 9a. */
  loadStage?: typeof loadStageData;
  /** Test seam: runs right after the handle is created (lock taken). */
  onLocked?: () => void;
  /** Test seams: a monotonic clock (ms) and the pause between attempts. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Never faster than real time (unlike `Date.now`, which the user can move). */
const monotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** The result fetch, tried this many times before `saved-not-shown`. */
const FETCH_ATTEMPTS = 3;

function failedFrom(error: SceneInsertionRequestError): SceneInsertionOutcome {
  return {
    kind: 'failed',
    status: error.status,
    code: error.code,
    message: error.message,
    details: error.details,
  };
}

export async function runSceneInsertion(
  input: RunSceneInsertionInput,
  deps: RunSceneInsertionDeps = {},
): Promise<SceneInsertionOutcome> {
  const { stageId } = input;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.clock ?? monotonicNow;
  const sleep = deps.sleep ?? delay;
  const step = deps.pollIntervalMs ?? 1000;
  // 1. Preconditions (no side effects).
  if (
    input.localGenerationRunning ||
    (input.gateRunning?.length ?? 0) > 0 ||
    isStageWritesHeld(stageId)
  ) {
    return { kind: 'busy' };
  }
  // 2. Lock.
  const handle = beginStageInsertion(stageId);
  handle.lock();
  let conflicted = false;
  const unsubscribe = onStageSaveConflict((conflict) => {
    if (conflict.stageId === stageId) conflicted = true;
  });
  try {
    deps.onLocked?.();
    // 3. Drain, 4. prove: no POST, no apply, local edits untouched on failure.
    await drainStageDocumentWrites(stageId);
    if (!isStageDocumentDurable(stageId) || conflicted) {
      return {
        kind: 'not-durable',
        pendingKeys: pendingStageDocumentKeys(stageId),
        conflict: conflicted,
      };
    }
    // 5. Hold, 6. re-prove (synchronously): catches a mark, a round or a
    // direct save that started between the prove and the hold.
    handle.holdWrites();
    if (!isStageDocumentDurable(stageId) || conflicted) {
      return {
        kind: 'not-durable',
        pendingKeys: pendingStageDocumentKeys(stageId),
        conflict: conflicted,
      };
    }
    // 7. Baseline.
    const baseline = handle.captureBaseline();

    // 8a. Admission. The server's clock, read right before the first POST (no
    // clock: nothing is sent, and the caller keeps the key). From the moment
    // it arrives, two separate bounds:
    //   - retryUntil: a POST may still start the run (T1 refuses one that
    //     reaches it after `admitBy`), so retries stop here;
    //   - releaseAt: any run this request started began by `admitBy` and
    //     commits only inside its lease (T2), so after the window, the
    //     longest lease and a grace nothing of it can still commit.
    const serverNow = await readServerClock(stageId, fetchImpl);
    if (serverNow === null) return { kind: 'unknown', insertionId: null };
    const clockReadAt = clock();
    const admitBy = serverNow + INSERTION_ADMISSION_WINDOW_MS;
    const retryUntil = clockReadAt + INSERTION_ADMISSION_WINDOW_MS;
    const releaseAt = retryUntil + INSERTION_MAX_LEASE_MS + INSERTION_RELEASE_GRACE_MS;
    // One exact body for every attempt of this run: same key, same deadline.
    const body = { ...input.request, admitBy };

    // 8b. Learn the row. POST (same key, same body) while it could start the
    // run; after an ambiguous answer read the key, which creates nothing. The
    // key is settled when the TE names its row, or reports none under the
    // Stage lock past `admitBy` (plus a clock margin) — then no attempt of
    // this run can start. Past `releaseAt` one last read is made: it queues
    // behind any T2 still holding the lock; only when it fails is the
    // outcome `unknown`.
    let status: SceneInsertionStatus | null = null;
    let refusal: SceneInsertionRequestError | null = null;
    let sent = 0;
    for (let pauses = 0; status === null; pauses += 1) {
      if (pauses > 0) await sleep(Math.min(step * pauses, step * 10));
      if (sent === 0 || (refusal === null && clock() < retryUntil)) {
        const answer = await postOnce(stageId, body, fetchImpl);
        sent += 1;
        if (answer.kind === 'status') {
          status = answer.status;
          break;
        }
        if (answer.kind === 'refused') {
          // Definite when it was the only request sent, or when the key
          // belongs to another request (ours can never start under it).
          // Otherwise an earlier attempt may still be on its way or queued on
          // the lock — even after a later attempt's ADMISSION_CLOSED, if the
          // clocks differ: settle the key first.
          if (sent === 1 || answer.error.code === 'IDEMPOTENCY_KEY_REUSED') {
            return failedFrom(answer.error);
          }
          refusal = answer.error;
        }
      }
      const last = clock() >= releaseAt;
      const read = await readByKey(stageId, body.idempotencyKey, fetchImpl);
      if (read.kind === 'status') {
        status = read.status;
        break;
      }
      if (
        read.kind === 'absent' &&
        read.serverNow !== null &&
        read.serverNow > admitBy + INSERTION_CLOCK_MARGIN_MS
      ) {
        return failedFrom(
          refusal ??
            new SceneInsertionRequestError(
              409,
              'INSERTION_ADMISSION_CLOSED',
              'the request did not start before its admission deadline; nothing was changed',
            ),
        );
      }
      if (last) return { kind: 'unknown', insertionId: null };
    }

    // 8c. A known row is settled by its id only — never another POST — still
    // holding, until it is terminal or can no longer commit. Every read error
    // is transient except the TE's own refusal of the read. Past `releaseAt`
    // one last read: its lazy reclaim waits for the row lock (held by a T2
    // until COMMIT) and settles an expired lease; `unknown` only when it fails.
    while (status.status === 'running') {
      const last = clock() >= releaseAt;
      if (!last) await sleep(step * 2);
      const read = await readById(stageId, status.insertionId, fetchImpl);
      if (read.kind === 'status') status = read.status;
      else if (read.kind === 'gone') return { kind: 'unknown', insertionId: status.insertionId };
      if (last && status.status === 'running') {
        return { kind: 'unknown', insertionId: status.insertionId };
      }
    }
    const { insertionId } = status;
    if (status.status === 'failed') {
      return {
        kind: 'failed',
        status: 409,
        code: status.errorCode ?? 'INSERTION_FAILED',
        message: `the slide could not be added (${status.errorCode ?? 'unknown'})`,
      };
    }

    // 9a. Fetch — the LAST await before the application. Retried while still
    // holding: giving up leaves lock-bypassing dirt on pre-shift revisions.
    let serverData: Awaited<ReturnType<typeof loadStageData>> = null;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS && !serverData; attempt += 1) {
      if (attempt > 0) await sleep(step * 2);
      try {
        serverData = await (deps.loadStage ?? loadStageData)(stageId);
      } catch {
        serverData = null;
      }
    }
    const saved = { insertionId, sceneId: status.newSceneId };
    if (!serverData) return { kind: 'saved-not-shown', ...saved, reason: 'fetch-error' };
    // 9b. Decide and apply in one synchronous step.
    const applied = applyInsertionResult(handle, serverData, baseline, {
      newSceneId: status.newSceneId,
      revTransitions: status.revTransitions ?? {},
    });
    if (applied === 'stale' || applied === 'unbound') {
      return { kind: 'saved-not-shown', ...saved, reason: applied };
    }
    return { kind: 'success', ...saved, applied };
  } finally {
    // 10. Release: after the apply returned, on a definite refusal or failure,
    // or once nothing of this request can still commit.
    handle.release();
    unsubscribe();
  }
}

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
 *    8 POST + poll     → same key on a transport retry
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

/** The gate for a Stage, or `null` when this tab holds no grant for it. */
export async function fetchInsertionGate(
  stageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InsertionGate | null> {
  const response = await fetchImpl(`${stagePath(stageId)}/scene-insertion`, {
    credentials: 'same-origin',
    cache: 'no-store',
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

/** Gateway answers that carry no server error code: the run may still be going. */
const GATEWAY_STATUSES = new Set([408, 502, 503, 504]);

/**
 * POST, retried with the SAME key only when the transport itself failed — or
 * when a gateway answered for the server (a proxy timeout, no error code): the
 * first POST waits for the whole run, so the server may still be generating,
 * and the same key replays it (`202` running, or the stored outcome). When
 * those retries run out the error is thrown as a transport failure, so the
 * caller reports `unknown` (keep the key), never a definite failure.
 */
export async function postSceneInsertion(
  stageId: string,
  body: SceneInsertionRequest,
  options: { fetchImpl?: typeof fetch; transportRetries?: number } = {},
): Promise<{ status: 200 | 202; insertion: SceneInsertionStatus | { insertionId: string } }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.transportRetries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${stagePath(stageId)}/scene-insertions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) {
      const error = await errorFrom(response);
      if (GATEWAY_STATUSES.has(response.status) && error.code === 'HTTP_ERROR') {
        lastError = new Error(`the gateway answered HTTP ${response.status}`);
        continue;
      }
      throw error;
    }
    const parsed = (await response.json()) as { insertion: SceneInsertionStatus };
    return { status: response.status === 202 ? 202 : 200, insertion: parsed.insertion };
  }
  throw lastError instanceof Error ? lastError : new Error('the request could not be sent');
}

export async function fetchInsertionStatus(
  stageId: string,
  insertionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SceneInsertionStatus> {
  const response = await fetchImpl(
    `${stagePath(stageId)}/scene-insertions/${encodeURIComponent(insertionId)}`,
    { credentials: 'same-origin', cache: 'no-store' },
  );
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as SceneInsertionStatus;
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
  /** The server refused or failed: nothing changed. */
  | { kind: 'failed'; status: number; code: string; message: string; details?: unknown }
  /** The outcome could not be read: keep the key; a later retry replays it. */
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
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Test seam: the read of step 9a. */
  loadStage?: typeof loadStageData;
  /** Test seam: runs right after the handle is created (lock taken). */
  onLocked?: () => void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 600 polls × 2 s = 20 min: longer than the server's default 900 s lease plus margin. */
const DEFAULT_MAX_POLLS = 600;
/** The result fetch, tried this many times before `saved-not-shown`. */
const FETCH_ATTEMPTS = 3;

export async function runSceneInsertion(
  input: RunSceneInsertionInput,
  deps: RunSceneInsertionDeps = {},
): Promise<SceneInsertionOutcome> {
  const { stageId } = input;
  const fetchImpl = deps.fetchImpl ?? fetch;
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

    // 8. POST, then poll.
    let status: SceneInsertionStatus | null = null;
    let insertionId: string | null = null;
    try {
      const posted = await postSceneInsertion(stageId, input.request, { fetchImpl });
      insertionId = posted.insertion.insertionId;
      if (posted.status === 200) status = posted.insertion as SceneInsertionStatus;
    } catch (error) {
      if (error instanceof SceneInsertionRequestError) {
        return {
          kind: 'failed',
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details,
        };
      }
      // The request may or may not have reached the server: the same key replays it.
      return { kind: 'unknown', insertionId: null };
    }
    // Poll until the row is terminal, still holding: a run the server may yet
    // commit must never release the hold early (the status read reclaims an
    // expired lease, so a terminal answer always comes). Transport and
    // gateway errors are retried; the budget outlasts the 900 s lease.
    for (let poll = 0; status === null || status.status === 'running'; poll += 1) {
      if (poll >= (deps.maxPolls ?? DEFAULT_MAX_POLLS)) return { kind: 'unknown', insertionId };
      if (poll > 0) await delay(deps.pollIntervalMs ?? 2000);
      try {
        status = await fetchInsertionStatus(stageId, insertionId, fetchImpl);
      } catch (error) {
        // A definite answer from the TE (e.g. INSERTION_NOT_FOUND) ends polling.
        if (error instanceof SceneInsertionRequestError && error.code !== 'HTTP_ERROR') {
          return { kind: 'unknown', insertionId };
        }
      }
    }
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
      if (attempt > 0) await delay(deps.pollIntervalMs ?? 2000);
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
    // 10. Release, after the apply returned (or on any refusal / failure).
    handle.release();
    unsubscribe();
  }
}

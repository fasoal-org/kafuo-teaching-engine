/**
 * Browser side of reviewer-driven single-slide regeneration
 * (single-slide-regeneration-plan §12).
 *
 *   1 lock X            → beginSceneRegeneration
 *   2 drain             → flushStageSave, then prove X durable (else no POST)
 *   3 hold writes       → this tab's own saves cannot bump X's revision
 *   4 POST              → same key on a transport retry
 *   5 settle            → status read: what the database holds for X now
 *   6 apply             → replaceSceneFromServer (no dirt, revision recorded)
 *   7 release           → lock + hold lifted, held edits scheduled
 *
 * Success is reported only when what the store displays equals what the
 * database holds and that is the regeneration's own result.
 */
import type { Scene } from '@/lib/types/stage';
import {
  beginSceneRegeneration,
  flushStageSave,
  isSceneDurable,
  replaceSceneFromServer,
  resyncStageScenesFromServer,
  useStageStore,
} from '@/lib/store/stage';

export const REGENERATION_LIMITS = {
  instruction: { min: 10, max: 2000 },
  reason: { min: 5, max: 1000 },
} as const;

export interface RegenerationGate {
  capability: 'read' | 'write';
  editable: boolean;
  versionStatus: string | null;
  supportedSceneTypes: string[];
  running: Array<{ sceneId: string; regenerationId: string }>;
}

/** The gate for a Stage, or `null` when this tab holds no grant for it. */
export async function fetchRegenerationGate(
  stageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegenerationGate | null> {
  const response = await fetchImpl(
    `/api/stages/${encodeURIComponent(stageId)}/scene-regeneration`,
    { credentials: 'same-origin', cache: 'no-store' },
  );
  if (!response.ok) return null;
  return (await response.json()) as RegenerationGate;
}

export function canRegenerateScene(gate: RegenerationGate | null, scene: Pick<Scene, 'type'>) {
  return (
    gate !== null &&
    gate.capability === 'write' &&
    gate.editable &&
    gate.supportedSceneTypes.includes(scene.type)
  );
}

export class SceneRegenerationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SceneRegenerationRequestError';
  }
}

export function newRegenerationKey(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `regen-${random}`.replace(/[^A-Za-z0-9_-]/g, '');
}

interface RegenerationResult {
  regenerationId: string;
  sceneId: string;
  status: 'succeeded';
  replayed: boolean;
  scene: Scene;
  resultSceneRev: number;
  current: { rev: number; scene: Scene } | null;
}

interface RegenerationStatus {
  regenerationId: string;
  sceneId: string;
  status: 'running' | 'succeeded' | 'failed';
  errorCode: string | null;
  resultSceneRev: number | null;
  scene: Scene | null;
  current: { rev: number; scene: Scene } | null;
}

async function errorFrom(response: Response): Promise<SceneRegenerationRequestError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  return new SceneRegenerationRequestError(
    response.status,
    body?.error?.code ?? (response.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR'),
    body?.error?.message ?? `the request failed (HTTP ${response.status})`,
    body?.error?.details,
  );
}

/** POST, retried with the SAME key only when the transport itself failed. */
export async function postSlideRegeneration(
  stageId: string,
  sceneId: string,
  body: { instruction: string; reason: string; idempotencyKey: string },
  options: { fetchImpl?: typeof fetch; transportRetries?: number } = {},
): Promise<{ status: 200; result: RegenerationResult } | { status: 202; regenerationId: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.transportRetries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(
        `/api/stages/${encodeURIComponent(stageId)}/scenes/${encodeURIComponent(sceneId)}/regenerate`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.status === 202) {
      const accepted = (await response.json()) as { regenerationId: string };
      return { status: 202, regenerationId: accepted.regenerationId };
    }
    if (!response.ok) throw await errorFrom(response);
    return { status: 200, result: (await response.json()) as RegenerationResult };
  }
  throw lastError instanceof Error ? lastError : new Error('the request could not be sent');
}

export async function fetchRegenerationStatus(
  stageId: string,
  regenerationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegenerationStatus> {
  const response = await fetchImpl(
    `/api/stages/${encodeURIComponent(stageId)}/scene-regenerations/${encodeURIComponent(regenerationId)}`,
    { credentials: 'same-origin', cache: 'no-store' },
  );
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as RegenerationStatus;
}

export type RegenerationOutcome =
  | { kind: 'success'; regenerationId: string }
  /** Regenerated, but the slide changed again since; the current copy is shown. */
  | { kind: 'changed-since'; regenerationId: string }
  /** The slide's pending edits could not be saved first: nothing was sent. */
  | { kind: 'not-durable' }
  | { kind: 'failed'; status: number; code: string; message: string; details?: unknown }
  /** The editor moved to another Stage; the late answer was not applied. */
  | { kind: 'stale' };

export interface RunSlideRegenerationInput {
  stageId: string;
  sceneId: string;
  instruction: string;
  reason: string;
  idempotencyKey: string;
}

export interface RunSlideRegenerationDeps {
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stageStillLoaded(stageId: string): boolean {
  return useStageStore.getState().stage?.id === stageId;
}

function displayedScene(sceneId: string): Scene | undefined {
  return useStageStore.getState().scenes.find((scene) => scene.id === sceneId);
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runSlideRegeneration(
  input: RunSlideRegenerationInput,
  deps: RunSlideRegenerationDeps = {},
): Promise<RegenerationOutcome> {
  const { stageId, sceneId } = input;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 1. Lock X.
  const handle = beginSceneRegeneration(stageId, sceneId);
  try {
    // 2. Drain, then PROVE X durable: a resolved flush is not proof.
    await flushStageSave().catch(() => {});
    if (!isSceneDurable(stageId, sceneId)) return { kind: 'not-durable' };
    // 3. Hold this Stage's writes until the regeneration settles.
    handle.holdWrites();
    // 4. POST.
    let regenerationId: string;
    let resultSceneRev: number | null = null;
    try {
      const posted = await postSlideRegeneration(
        stageId,
        sceneId,
        {
          instruction: input.instruction,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
        { fetchImpl },
      );
      if (posted.status === 200) {
        regenerationId = posted.result.regenerationId;
        resultSceneRev = posted.result.resultSceneRev;
      } else {
        regenerationId = posted.regenerationId;
      }
    } catch (error) {
      if (error instanceof SceneRegenerationRequestError) {
        if (error.code === 'SCENE_CHANGED_DURING_REGENERATION' && stageStillLoaded(stageId)) {
          // Show what the database holds now.
          await resyncStageScenesFromServer(stageId, [sceneId]).catch(() => {});
        }
        return {
          kind: 'failed',
          status: error.status,
          code: error.code,
          message: error.message,
          details: error.details,
        };
      }
      return {
        kind: 'failed',
        status: 0,
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // 5. Settle on what the database holds now (waiting out a running replay).
    let status = await fetchRegenerationStatus(stageId, regenerationId, fetchImpl);
    for (let poll = 0; status.status === 'running' && poll < (deps.maxPolls ?? 300); poll += 1) {
      await delay(deps.pollIntervalMs ?? 2000);
      status = await fetchRegenerationStatus(stageId, regenerationId, fetchImpl);
    }
    if (status.status === 'failed') {
      return {
        kind: 'failed',
        status: 409,
        code: status.errorCode ?? 'REGENERATION_FAILED',
        message: `the regeneration failed (${status.errorCode ?? 'unknown'})`,
      };
    }
    resultSceneRev ??= status.resultSceneRev;
    if (!stageStillLoaded(stageId)) return { kind: 'stale' };
    // 6. Apply the server copy without dirt.
    const applied = status.current
      ? replaceSceneFromServer(stageId, status.current.scene, status.current.rev)
      : null;
    if (!status.current) await resyncStageScenesFromServer(stageId, [sceneId]).catch(() => {});
    const truthful =
      status.current !== null &&
      applied !== null &&
      resultSceneRev !== null &&
      status.current.rev === resultSceneRev &&
      displayedScene(sceneId) === applied &&
      (status.scene === null || sameContent(status.scene, status.current.scene));
    return truthful
      ? { kind: 'success', regenerationId }
      : { kind: 'changed-since', regenerationId };
  } finally {
    // 7. Release (and schedule what was held).
    handle.release();
  }
}

/**
 * Phase 3: put back the slide a regeneration replaced, then show exactly what
 * the database now holds.
 */
export async function restoreSlideRegeneration(
  stageId: string,
  regenerationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await fetchImpl(
    `/api/stages/${encodeURIComponent(stageId)}/scene-regenerations/${encodeURIComponent(regenerationId)}/restore`,
    { method: 'POST', credentials: 'same-origin' },
  );
  if (!response.ok) return { ok: false, code: (await errorFrom(response)).code };
  const restored = (await response.json()) as {
    sceneId: string;
    scene: Scene;
    restoredSceneRev: number;
  };
  replaceSceneFromServer(stageId, restored.scene, restored.restoredSceneRev);
  return { ok: true };
}

/**
 * ED-3 (critical items before package regeneration, 27 Nov 2026): the server half of
 * the rail's delete guard. A package scene alone at its flow position (an objective's
 * check quiz, an objective's last slide) is never deleted: without it the lesson
 * refuses every new slide and Submit, and the teacher cannot put it back. The rail
 * refuses such a delete (f2139cd1); this guard refuses the save that carries one —
 * from an editor tab older than that guard, or any other caller of the document route.
 *
 * Checked before the store runs, beside the Quran/hadith pin guard, on the writes that
 * can take a page away from its position:
 * - `PUT /documents/<s>` — a whole-document save (how the editor saves a delete, a
 *   reorder or any structure change);
 * - `PUT /documents/<s>/scenes/<x>` — a scene write that moves its scene off a position;
 * - `DELETE /documents/<s>/scenes/<x>`.
 * A DELTA check ({@link emptiedFlowPositions}): only a position the STORED scenes hold
 * and the written scenes do not is refused, so a lesson whose order is already broken
 * keeps saving; scenes without a flow position (non-package stages) are never judged.
 */
import { emptiedFlowPositions } from '@/lib/edit/scene-defaults';
import type { Scene } from '@/lib/types/stage';

/** The refusal code: the editor resyncs and names the page that came back. */
export const SCENE_DELETE_EMPTIES_FLOW_POSITION = 'SCENE_DELETE_EMPTIES_FLOW_POSITION';

export interface FlowPositionRefusal {
  status: 422;
  code: typeof SCENE_DELETE_EMPTIES_FLOW_POSITION;
  message: string;
  /** The flow positions the write would leave without their page. */
  positions: number[];
  /** The stored scenes that held them (the pages the write takes away). */
  scenes: Array<{ id: string; flowIndex: number }>;
}

interface SceneReader {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

type FlowScene = Pick<Scene, 'id' | 'type' | 'teachingStage'>;

type WriteTarget =
  | { stageId: string; kind: 'document' }
  | { stageId: string; kind: 'scene-put'; sceneId: string }
  | { stageId: string; kind: 'scene-delete'; sceneId: string };

/** The write of the document route this guard covers, or `null`. */
function writeTarget(method: string, path: string): WriteTarget | null {
  if (method !== 'PUT' && method !== 'DELETE') return null;
  let parts: string[];
  try {
    parts = new URL(path, 'http://documents.invalid').pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts[0] !== 'documents' || !parts[1]) return null;
  if (parts.length === 2) return method === 'PUT' ? { stageId: parts[1], kind: 'document' } : null;
  if (parts.length === 4 && parts[2] === 'scenes' && parts[3]) {
    return method === 'PUT'
      ? { stageId: parts[1], kind: 'scene-put', sceneId: parts[3] }
      : { stageId: parts[1], kind: 'scene-delete', sceneId: parts[3] };
  }
  return null;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A written scene's position, read defensively (the store validates the rest). */
function flowSceneOf(value: unknown): FlowScene | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; type?: unknown; teachingStage?: unknown };
  if (typeof record.id !== 'string') return null;
  const stage = record.teachingStage as { key?: unknown; flowIndex?: unknown } | undefined;
  const teachingStage =
    stage && typeof stage.key === 'string' && typeof stage.flowIndex === 'number'
      ? { key: stage.key, flowIndex: stage.flowIndex }
      : undefined;
  return {
    id: record.id,
    type: (typeof record.type === 'string' ? record.type : 'slide') as Scene['type'],
    ...(teachingStage ? { teachingStage } : {}),
  };
}

/** The stored scenes' positions (only the two fields the rule reads). */
async function storedFlowScenes(queryable: SceneReader, stageId: string): Promise<FlowScene[]> {
  const result = await queryable.query(
    `SELECT id, data->>'type' AS type, data->'teachingStage' AS teaching_stage
       FROM document_scenes WHERE stage_id = $1`,
    [stageId],
  );
  return result.rows.flatMap((row) => {
    const scene = flowSceneOf({
      id: row.id,
      type: row.type,
      teachingStage: decode(row.teaching_stage) ?? undefined,
    });
    return scene ? [scene] : [];
  });
}

/** The refusal when `after` leaves a position of `before` without its page, else `null`. */
export function flowPositionRefusal(
  before: readonly FlowScene[],
  after: readonly FlowScene[],
): FlowPositionRefusal | null {
  const positions = emptiedFlowPositions(before, after);
  if (positions.length === 0) return null;
  const emptied = new Set(positions);
  const kept = new Set(after.map((scene) => scene.id));
  return {
    status: 422,
    code: SCENE_DELETE_EMPTIES_FLOW_POSITION,
    message: `this write would leave the lesson's flow position${
      positions.length === 1 ? '' : 's'
    } ${positions.join(', ')} without its page; the lesson would then refuse every new slide and Submit, so the page is kept`,
    positions,
    scenes: before.flatMap((scene) =>
      scene.teachingStage && emptied.has(scene.teachingStage.flowIndex) && !kept.has(scene.id)
        ? [{ id: scene.id, flowIndex: scene.teachingStage.flowIndex }]
        : [],
    ),
  };
}

/**
 * The refusal for this request, or `null` to let it through. Reads a clone of the body,
 * so the store still receives the original stream; an unreadable body is left to the
 * store's own validation. A Stage none of whose stored scenes holds a flow position
 * (any non-package stage) costs one read and is never refused.
 */
export async function flowPositionDeleteRefusal(
  request: Request,
  path: string,
  queryable: SceneReader,
): Promise<FlowPositionRefusal | null> {
  const target = writeTarget(request.method, path);
  if (!target) return null;
  const stored = await storedFlowScenes(queryable, target.stageId);
  if (!stored.some((scene) => scene.teachingStage)) return null;
  if (target.kind === 'scene-delete') {
    return flowPositionRefusal(
      stored,
      stored.filter((scene) => scene.id !== target.sceneId),
    );
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  if (target.kind === 'scene-put') {
    const written = flowSceneOf(body);
    if (!written || written.id !== target.sceneId) return null;
    // A scene write that leaves `teachingStage` out keeps the stored one (the store
    // carries the lineage forward, owner-bound-document-store); only an explicit value
    // (`null` included) moves the scene.
    const keepsStored = (body as { teachingStage?: unknown }).teachingStage === undefined;
    const before = stored.find((scene) => scene.id === target.sceneId);
    const after =
      keepsStored && before?.teachingStage
        ? { ...written, teachingStage: before.teachingStage }
        : written;
    return flowPositionRefusal(stored, [
      ...stored.filter((scene) => scene.id !== target.sceneId),
      after,
    ]);
  }
  const scenes = (body as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return null;
  return flowPositionRefusal(
    stored,
    scenes.flatMap((scene) => {
      const written = flowSceneOf(scene);
      return written ? [written] : [];
    }),
  );
}

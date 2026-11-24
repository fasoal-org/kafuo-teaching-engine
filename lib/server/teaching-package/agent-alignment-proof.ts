/**
 * Kafuo Agent API phase 2, A8 (plan §5 F2.5 with §10 R-H1/R-H2): the proof that a stale
 * slide was made stale by this tenant's agent alone, so the agent may confirm it.
 *
 * The owner's rule: the bot confirms only slides its own op made stale. The baseline does
 * not record why a slide went stale, so the proof comes from the rows every landed write
 * leaves on the slide:
 *
 * | event                                   | source                                   | agent's? |
 * |-----------------------------------------|------------------------------------------|----------|
 * | a regeneration (full or narration-only) | `teaching_package_scene_regenerations`   | by actor |
 * | an F2 direct edit                       | `teaching_package_agent_ops` edit rows   | by actor |
 * | a restore of a regeneration             | `restored_at` on the regeneration row    | never    |
 * | an insertion (the new slide or a slide  | `teaching_package_scene_insertions`      | never    |
 * |  whose revision it moved)               |                                          |          |
 *
 * Confirmable only when ALL hold:
 * 1. The slide's latest event is a regeneration or an edit by an `agent:<id>` actor (the
 *    version is read under the tenant, so that is this tenant's ai_assistant user; TE rows
 *    record the user, never the key — §10 LOW).
 * 2. Nothing changed since: the slide's material fingerprint WITHOUT narration audio equals
 *    the same projection of that op's result (R-H1: voicing the line afterwards bumps the
 *    revision and writes audio ids into `actions`, so neither rev nor the plain fingerprint
 *    can match).
 * 3. The slide was aligned before that op (R-H2), or stale only by an earlier op of the
 *    agent (the same proof, one op back): a slide stale before the agent touched it stays
 *    with the teacher. A regeneration row's `previous_scene` is checked here; an edit row
 *    carries the answer it computed at write time (`aligned_before`).
 * 4. Only the material fingerprint differs from the baseline: an assignment or
 *    classification change is never the agent's to confirm.
 *
 * Insertion neighbours are not confirmable in this phase (R-H2). Pure; the loader is below.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  deriveSceneAlignment,
  sceneMaterialFingerprint,
} from '@/lib/server/teaching-package/alignment';
import { listAgentEditRows } from '@/lib/server/teaching-package/agent-op-records';
import { withoutNarrationAudio } from '@/lib/server/teaching-package/scene-narration-audio';
import type { AppScene } from '@/lib/types/stage';

const AGENT_ACTOR = /^agent:[1-9][0-9]{0,18}$/;
/** A chain of agent ops longer than this is not followed (each hop is one op back). */
const MAX_CHAIN = 25;

export type SceneWriteEvent =
  | {
      kind: 'regeneration';
      /** When it landed (`completed_at`). */
      at: number;
      /** When it started: its `previous_scene` is the slide as it stood then. */
      startedAt: number;
      actorRef: string;
      previousScene: AppScene | null;
      resultScene: AppScene | null;
    }
  | {
      kind: 'edit';
      at: number;
      actorRef: string;
      resultFingerprint: string;
      alignedBefore: boolean;
    }
  | { kind: 'restore' | 'insertion'; at: number };

export type AgentProofRefusal =
  | 'no-baseline'
  | 'not-material-only'
  | 'no-agent-op'
  | 'last-write-not-agent'
  | 'edited-since'
  | 'stale-before';

export type AgentAlignmentProof =
  | { ok: true; event: Extract<SceneWriteEvent, { kind: 'regeneration' | 'edit' }> }
  | { ok: false; reason: AgentProofRefusal };

/** The material fingerprint without narration audio (R-H1). */
export function noAudioFingerprint(scene: AppScene): string {
  return sceneMaterialFingerprint(withoutNarrationAudio(scene));
}

/** The slide differs from its baseline in material content only (never assignment). */
function staleByContentOnly(scene: AppScene): boolean {
  const baseline = scene.alignmentBaseline;
  if (!baseline) return false;
  return deriveSceneAlignment({
    ...scene,
    alignmentBaseline: { ...baseline, fingerprint: sceneMaterialFingerprint(scene) },
  } as AppScene).aligned;
}

function eventFingerprint(event: SceneWriteEvent): string | null {
  if (event.kind === 'edit') return event.resultFingerprint;
  if (event.kind === 'regeneration') {
    return event.resultScene ? noAudioFingerprint(event.resultScene) : null;
  }
  return null;
}

/**
 * Whether `scene` (as it stands now) was made stale by the agent alone. `events` are every
 * landed write event of this slide, any order. Pure.
 */
export function agentAlignmentProof(
  scene: AppScene,
  events: readonly SceneWriteEvent[],
  depth = 0,
): AgentAlignmentProof {
  if (!scene.alignmentBaseline) return { ok: false, reason: 'no-baseline' };
  if (!staleByContentOnly(scene)) return { ok: false, reason: 'not-material-only' };
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const latest = ordered[ordered.length - 1];
  if (!latest) return { ok: false, reason: 'no-agent-op' };
  if (
    (latest.kind !== 'regeneration' && latest.kind !== 'edit') ||
    !AGENT_ACTOR.test(latest.actorRef)
  ) {
    return { ok: false, reason: 'last-write-not-agent' };
  }
  if (eventFingerprint(latest) !== noAudioFingerprint(scene)) {
    return { ok: false, reason: 'edited-since' };
  }
  let alignedBefore: boolean;
  if (latest.kind === 'edit') {
    alignedBefore = latest.alignedBefore;
  } else {
    const previous = latest.previousScene;
    alignedBefore =
      !!previous &&
      (deriveSceneAlignment(previous).aligned ||
        (depth < MAX_CHAIN &&
          agentAlignmentProof(
            previous,
            ordered.filter((event) => event.at < latest.startedAt),
            depth + 1,
          ).ok));
  }
  if (!alignedBefore) return { ok: false, reason: 'stale-before' };
  return { ok: true, event: latest };
}

/**
 * A8 "aligned before" for a NEW agent op on `scene`: aligned now, or stale only by this
 * agent's own earlier ops (so two edits on one slide stay confirmable).
 */
export function alignedOrStaleByAgent(
  scene: AppScene,
  events: readonly SceneWriteEvent[],
): boolean {
  return deriveSceneAlignment(scene).aligned || agentAlignmentProof(scene, events).ok;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Every landed write event of the listed slides of one version's Stage. Read-only. */
export async function loadSceneWriteEvents(
  queryable: Queryable,
  versionId: string,
  stageId: string,
  sceneIds: readonly string[],
): Promise<Map<string, SceneWriteEvent[]>> {
  const events = new Map<string, SceneWriteEvent[]>(sceneIds.map((id) => [id, []]));
  if (sceneIds.length === 0) return events;
  const push = (sceneId: string, event: SceneWriteEvent) => events.get(sceneId)?.push(event);

  const regenerations = await queryable.query<{
    scene_id: string;
    actor_ref: string;
    requested_at: number | string;
    completed_at: number | string | null;
    restored_at: number | string | null;
    previous_scene: unknown;
    result_scene: unknown;
  }>(
    `SELECT scene_id, actor_ref, requested_at, completed_at, restored_at, previous_scene,
            result_scene
       FROM teaching_package_scene_regenerations
      WHERE version_id = $1 AND stage_id = $2 AND status = 'succeeded'
        AND scene_id = ANY($3::text[])`,
    [versionId, stageId, [...sceneIds]],
  );
  for (const row of regenerations.rows) {
    const startedAt = Number(row.requested_at);
    push(row.scene_id, {
      kind: 'regeneration',
      at: Number(row.completed_at ?? row.requested_at),
      startedAt,
      actorRef: row.actor_ref,
      previousScene: json<AppScene>(row.previous_scene),
      resultScene: json<AppScene>(row.result_scene),
    });
    if (row.restored_at !== null) {
      push(row.scene_id, { kind: 'restore', at: Number(row.restored_at) });
    }
  }

  for (const row of await listAgentEditRows(queryable, versionId, sceneIds)) {
    push(row.sceneId, {
      kind: 'edit',
      at: row.at,
      actorRef: row.actorRef,
      resultFingerprint: row.resultFingerprint,
      alignedBefore: row.alignedBefore,
    });
  }

  const insertions = await queryable.query<{
    new_scene_id: string;
    scene_rev_transitions: unknown;
    requested_at: number | string;
    completed_at: number | string | null;
  }>(
    `SELECT new_scene_id, scene_rev_transitions, requested_at, completed_at
       FROM teaching_package_scene_insertions
      WHERE version_id = $1 AND stage_id = $2 AND status = 'succeeded'`,
    [versionId, stageId],
  );
  for (const row of insertions.rows) {
    const at = Number(row.completed_at ?? row.requested_at);
    const touched = new Set<string>([row.new_scene_id]);
    const transitions = json<Record<string, unknown>>(row.scene_rev_transitions) ?? {};
    for (const id of Object.keys(transitions)) touched.add(id);
    for (const id of touched) push(id, { kind: 'insertion', at });
  }
  return events;
}

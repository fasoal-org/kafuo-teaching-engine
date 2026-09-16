/**
 * Exact Teaching Model Flow validation (FRD §11.3, plan §4.3.7).
 *
 * Runs AFTER `generateClassroom` and BEFORE `completeGenerationAttempt` (an
 * invalid Stage is never bound) and again before Submit for Review (manual
 * edits cannot break the sequence). Validation inspects the FINAL scenes —
 * `generateClassroom` may skip a failed scene, so prompt output alone proves
 * nothing.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { TeachingFlowEntry } from '@openmaic/generation';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingFlowEntry as AppTeachingFlowEntry } from '@/lib/types/teaching-package';

export interface ExactFlowViolation {
  reason:
    | 'missing_teaching_stage'
    | 'invalid_flow_index'
    | 'key_index_mismatch'
    | 'outline_scene_mismatch'
    | 'ambiguous_scene_order'
    | 'missing_stage'
    | 'reordered_stage'
    | 'stage_reentry'
    | 'unexpected_stage'
    | 'empty_flow'
    | 'no_scenes';
  message: string;
  offendingSceneIds: string[];
  /** The collapsed scene flowIndex sequence actually found (when computable). */
  actual?: number[];
  /** The authoritative flow indices [0..flow.length-1]. */
  expected: number[];
}

export type ExactFlowResult = { valid: true } | { valid: false; violation: ExactFlowViolation };

interface SceneWithStage {
  id: string;
  order: number;
  teachingStage?: { key: string; flowIndex: number };
  outlineId?: string;
}

/** Order scenes by persisted `order`; duplicate/ambiguous order is invalid. */
function orderScenes(scenes: SceneWithStage[]): { ordered: SceneWithStage[] } | { ambiguous: boolean } {
  const finite = scenes.every(
    (scene) => typeof scene.order === 'number' && Number.isFinite(scene.order),
  );
  if (!finite) return { ambiguous: true };
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.order === sorted[index - 1]!.order) {
      return { ambiguous: true };
    }
  }
  return { ordered: sorted };
}

/**
 * Validate the exact-flow contract. `outlines` (when supplied) must carry the
 * same `(key, flowIndex)` as their linked scene (FRD §11.3 step 3e).
 */
export function validateExactTeachingFlow(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[] | readonly AppTeachingFlowEntry[],
  outlines?: ReadonlyArray<{ id: string; teachingStage?: { key: string; flowIndex: number } }>,
): ExactFlowResult {
  if (flow.length === 0) {
    return {
      valid: false,
      violation: {
        reason: 'empty_flow',
        message: 'the authoritative Teaching Model Flow is empty',
        offendingSceneIds: [],
        expected: [],
      },
    };
  }
  if (scenes.length === 0) {
    return {
      valid: false,
      violation: {
        reason: 'no_scenes',
        message: 'no scenes were generated',
        offendingSceneIds: [],
        expected: flow.map((_, index) => index),
      },
    };
  }

  const ordering = orderScenes(scenes as unknown as SceneWithStage[]);
  if ('ambiguous' in ordering) {
    return {
      valid: false,
      violation: {
        reason: 'ambiguous_scene_order',
        message: 'scene order is ambiguous (duplicate or non-finite order values)',
        offendingSceneIds: (scenes as unknown as SceneWithStage[]).map((scene) => scene.id),
        expected: flow.map((_, index) => index),
      },
    };
  }
  const ordered = ordering.ordered;
  const expected = flow.map((_, index) => index);

  const outlineById = new Map((outlines ?? []).map((outline) => [outline.id, outline]));

  // Per-scene checks: presence, index bounds, key equality, outline agreement.
  for (const scene of ordered) {
    const stage = scene.teachingStage;
    if (!stage) {
      return {
        valid: false,
        violation: {
          reason: 'missing_teaching_stage',
          message: `scene ${scene.id} carries no teachingStage`,
          offendingSceneIds: [scene.id],
          expected,
        },
      };
    }
    if (
      typeof stage.flowIndex !== 'number' ||
      !Number.isInteger(stage.flowIndex) ||
      stage.flowIndex < 0 ||
      stage.flowIndex >= flow.length
    ) {
      return {
        valid: false,
        violation: {
          reason: 'invalid_flow_index',
          message: `scene ${scene.id} has flowIndex ${String(stage.flowIndex)} outside the flow`,
          offendingSceneIds: [scene.id],
          expected,
        },
      };
    }
    if (stage.key !== flow[stage.flowIndex]!.stage) {
      return {
        valid: false,
        violation: {
          reason: 'key_index_mismatch',
          message: `scene ${scene.id} key "${stage.key}" does not equal flow[${stage.flowIndex}].stage "${flow[stage.flowIndex]!.stage}"`,
          offendingSceneIds: [scene.id],
          expected,
        },
      };
    }
    if (scene.outlineId) {
      const outline = outlineById.get(scene.outlineId);
      if (
        outline &&
        (outline.teachingStage?.key !== stage.key ||
          outline.teachingStage?.flowIndex !== stage.flowIndex)
      ) {
        return {
          valid: false,
          violation: {
            reason: 'outline_scene_mismatch',
            message: `scene ${scene.id} disagrees with its outline ${scene.outlineId} on teachingStage`,
            offendingSceneIds: [scene.id],
            expected,
          },
        };
      }
    }
  }

  // Sequence check: collapse consecutive equal flowIndex values ONLY, then
  // compare exactly with [0..flow.length-1].
  const indices = ordered.map((scene) => scene.teachingStage!.flowIndex);
  const collapsed: number[] = [];
  for (const index of indices) {
    if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== index) {
      collapsed.push(index);
    }
  }
  const matches = collapsed.length === expected.length && collapsed.every((v, i) => v === expected[i]);
  if (matches) return { valid: true };

  const reason: ExactFlowViolation['reason'] = collapsed.some((value, index) =>
    collapsed.indexOf(value) !== index || collapsed.lastIndexOf(value) !== index
      ? index !== collapsed.indexOf(value)
      : false,
  )
    ? 'stage_reentry'
    : collapsed.length < expected.length
      ? 'missing_stage'
      : 'reordered_stage';

  // Sharpen the classification for the common shapes the FRD names.
  const monotonic = collapsed.every((value, index) => index === 0 || value > collapsed[index - 1]!);
  const finalReason: ExactFlowViolation['reason'] = monotonic
    ? collapsed.length < expected.length
      ? 'missing_stage'
      : 'unexpected_stage'
    : 'stage_reentry';

  return {
    valid: false,
    violation: {
      reason: reason === 'stage_reentry' ? reason : finalReason,
      message: `the scene sequence does not cover the exact flow (collapsed [${collapsed.join(', ')}] vs expected [${expected.join(', ')}])`,
      offendingSceneIds: ordered.map((scene) => scene.id),
      actual: collapsed,
      expected,
    },
  };
}

/**
 * The authoritative flow for an existing version (plan §4.3.7): read via
 * `currentAttemptId` → its input snapshot's `teachingFlow`; when the current
 * Stage came from a successor clone (`currentAttemptId` null), walk the
 * predecessor chain until a generated attempt is found. Legacy versions with
 * no flow anywhere return `null` (no flow gate applies).
 */
export async function readFlowForVersion(
  tx: Queryable,
  versionId: string,
): Promise<AppTeachingFlowEntry[] | null> {
  const visited = new Set<string>();
  let currentId: string | null = versionId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const versionResult = await tx.query<Record<string, unknown>>(
      `SELECT current_attempt_id, predecessor_version_id
         FROM teaching_package_versions
        WHERE id = $1`,
      [currentId],
    );
    const row = versionResult.rows[0] as
      | { current_attempt_id: string | null; predecessor_version_id: string | null }
      | undefined;
    if (!row) return null;
    if (row.current_attempt_id) {
      const attemptResult = await tx.query<Record<string, unknown>>(
        `SELECT input_snapshot
           FROM teaching_package_generation_attempts
          WHERE id = $1`,
        [row.current_attempt_id],
      );
      const snapshot = attemptResult.rows[0]?.input_snapshot as
        | { teachingFlow?: AppTeachingFlowEntry[] }
        | undefined;
      if (snapshot?.teachingFlow && snapshot.teachingFlow.length > 0) {
        return snapshot.teachingFlow;
      }
      return null;
    }
    currentId = row.predecessor_version_id;
  }
  return null;
}

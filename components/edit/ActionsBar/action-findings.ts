'use client';

/**
 * The timeline's per-Action governance finding marker (Module 3/4 W5 — plan
 * §7.5, TAE-RQ-025/027, the C-8 reuse decision).
 *
 * The marker is sourced from the SAME inspection GET the Teaching Skills
 * panel reads (`/api/stages/[stageId]/teaching-skills`), so there is one
 * governance projection and no second Action rendering: the timeline already
 * renders Action identity, type, narration and targeting — this file adds
 * only an identity-keyed marker on rows the inspection flags.
 *
 * The payload carries Action identity and findings ONLY (TAE-RQ-027): the
 * marker consumes `actionId` + `code` and never touches Action content. A
 * finding with no `actionId` (the empty-id structural finding) cannot mark a
 * row; it still reaches the reviewer through the panel's failures list.
 *
 * Self-effacing exactly like the panel: a non-package classroom, a legacy
 * stage, an unreachable API or a fetch failure renders nothing and never
 * interferes with ordinary editing.
 */
import { useEffect, useState } from 'react';

import { useStageStore } from '@/lib/store/stage';

/** One inspection finding, projected for the row marker (identity + code). */
export interface SceneActionFindingView {
  /** The offending Action's id — the timeline row key. */
  actionId?: string;
  actionType?: string;
  code: string;
  message: string;
}

interface InspectionSceneView {
  sceneId: string;
  actionFindings?: SceneActionFindingView[];
}

interface InspectionResponseView {
  governed: boolean;
  scenes?: InspectionSceneView[];
}

const EMPTY_FINDINGS: ReadonlyMap<string, SceneActionFindingView[]> = new Map();

/**
 * The current Scene's Action findings keyed by Action id. Re-fetches when the
 * Stage changes; hides itself for every non-governed answer.
 */
export function useSceneActionFindings(
  sceneId: string,
): ReadonlyMap<string, SceneActionFindingView[]> {
  const stageId = useStageStore((state) => state.stage?.id ?? null);
  // The resolved answer is stamped with the Stage it belongs to and only used
  // while that Stage is current — a Stage switch naturally reads as "no
  // findings yet" without a synchronous reset in the effect.
  const [resolved, setResolved] = useState<{
    stageId: string;
    byActionId: ReadonlyMap<string, SceneActionFindingView[]>;
  } | null>(null);

  useEffect(() => {
    if (!stageId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/stages/${encodeURIComponent(stageId)}/teaching-skills`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as InspectionResponseView;
        if (cancelled || !payload?.governed) return;
        const findings = payload.scenes?.find((scene) => scene.sceneId === sceneId)?.actionFindings;
        if (!findings || findings.length === 0) return;
        const keyed = new Map<string, SceneActionFindingView[]>();
        for (const finding of findings) {
          if (finding.actionId === undefined || finding.actionId === '') continue;
          const list = keyed.get(finding.actionId) ?? [];
          list.push(finding);
          keyed.set(finding.actionId, list);
        }
        if (!cancelled && keyed.size > 0) setResolved({ stageId, byActionId: keyed });
      } catch {
        // Offline dev, non-package classroom — stay hidden.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sceneId, stageId]);

  return resolved && resolved.stageId === stageId ? resolved.byActionId : EMPTY_FINDINGS;
}

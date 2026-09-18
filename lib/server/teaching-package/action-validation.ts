/**
 * Shared canonical Action validation (Module 3/4 W3 — TAE-RQ-022/023/024/004/
 * 034/027, plan §7.3/§9). One validator, invoked at two points for two
 * different reasons:
 *
 * ```text
 * generation gate  → an invalid governed artifact never becomes the current output
 * submit gate      → independent re-proof against the persisted current Stage
 * ```
 *
 * The module introduces no new structural logic: it is a caller of the DSL's
 * `isActionType` / `validateAction` (invoke-don't-reimplement, the pattern
 * `scene-inspection.ts` established for the W12 validators), plus the
 * deterministic reference checks classified in plan §9.2. Three callers need
 * the same findings — the generation gate, the submit gate, and (later) W5's
 * reviewer attribution — so no second copy of this logic may be created.
 *
 * Reference categories — exactly four are validated, each resolvable against
 * PERSISTED document state:
 * - `spotlight.elementId` → the Scene's own `content.canvas.elements`
 *   (`processActions` already repairs this at generation time to the first
 *   element; the gate catches what repair could not fix)
 * - `laser.elementId` → same elements — NOT repaired by `processActions`,
 *   unguarded before W3
 * - `play_video.elementId` → a canvas element with `type === 'video'`, across
 *   ALL slide Scenes — mirroring `resolveActionVideoMedia`
 *   (lib/action/engine.ts), which is what playback actually resolves
 * - `discussion.agentId` → the persisted roster (`stage.generatedAgentConfigs`
 *   — full configs — or `stage.agentIds`, the compact default-agent form of
 *   the same roster; `processActions` already assigns a random student when
 *   invalid)
 *
 * Three categories are DELIBERATELY excluded. Each exclusion has code
 * evidence; do not "fix" them:
 * - `speech.audioId` — an absent or unresolved audioId is a degradation, not
 *   an invalidity: `SpeechAction.audioId` documents legacy read fallbacks, and
 *   `normalizeNarrationReferences` normalizes at persistence time. Refusing it
 *   would block packages the execution contract deliberately tolerates.
 * - `wb_delete.elementId` / `wb_edit_code.elementId` — whiteboard elements are
 *   created by earlier `wb_draw_*` Actions during playback and never persist
 *   in the document, so a document-state validator has nothing to resolve
 *   against; `elementId` on `wb_draw_*` is optional and the engine tolerates a
 *   missing target, so even a same-Scene sequence check would refuse packages
 *   the contract accepts.
 * - `widget_*.target` — a CSS selector posted into an opaque iframe by
 *   `sendWidgetMessage`, resolved inside widget-authored HTML that Teaching
 *   Engine does not own (TAE-RQ-037, Interactive Components retain these
 *   semantics).
 *
 * Scene references are not a category: Actions are Scene-owned and never
 * reference another Scene. Recorded here so the category is not left
 * unexamined.
 *
 * Diagnostics (TAE-RQ-027): findings carry identity ONLY — sceneId, action id,
 * action type, field path, reference category. They never carry `text`,
 * `content`, `code`, `latex`, `topic`, `state`, source prose, signed URLs, or
 * provider secrets.
 */
import { isActionType, validateAction, type Action } from '@openmaic/dsl';

import type { AppScene, Stage } from '@/lib/types/stage';

/** The three refusal codes (plan §7.3 / §9.3). */
export type ActionValidationCode =
  | 'ACTION_STRUCTURE_INVALID'
  | 'ACTION_TYPE_UNKNOWN'
  | 'ACTION_REFERENCE_INVALID';

/** Reference categories actually validated (§9.2). */
export type ActionReferenceCategory = 'element' | 'media' | 'agent';

/** One finding. Identity only — see the diagnostics contract above. */
export interface ActionValidationFinding {
  sceneId: string;
  /** The action's `id`, when the action carries one. */
  actionId?: string;
  /** The action's `type` verbatim — including an unknown one (TAE-RQ-034). */
  actionType?: string;
  code: ActionValidationCode;
  /** Field path, DSL-validator style (e.g. `/elementId`). */
  path?: string;
  /** Reference category, for ACTION_REFERENCE_INVALID only. */
  category?: ActionReferenceCategory;
  message: string;
}

export interface ValidateSceneActionStructureOptions {
  /** The persisted Stage — the roster `discussion.agentId` resolves against. */
  stage?: Pick<Stage, 'generatedAgentConfigs' | 'agentIds'> | null;
  /**
   * Skip the unknown-type refusal while keeping structure and reference
   * checks. §9.3 uses it only where unknown types may remain (clone-only
   * legacy successors); the two W3 gates never set it.
   */
  allowUnknownTypes?: boolean;
}

interface CanvasElementLike {
  id: string;
  type: string;
}

/** The element ids of one Scene's slide canvas, in canvas order. */
function canvasElements(scene: AppScene): CanvasElementLike[] {
  if (scene.content.type !== 'slide') return [];
  return scene.content.canvas.elements as unknown as CanvasElementLike[];
}

/**
 * Validate the canonical structure and deterministic references of every
 * Action of every Scene, in array order. Pure, synchronous, no I/O.
 */
export function validateSceneActionStructure(
  scenes: readonly AppScene[],
  options: ValidateSceneActionStructureOptions = {},
): ActionValidationFinding[] {
  const findings: ActionValidationFinding[] = [];

  // play_video resolves across ALL slide Scenes (resolveActionVideoMedia).
  const videoElementIds = new Set<string>();
  for (const scene of scenes) {
    for (const element of canvasElements(scene)) {
      if (element.type === 'video') videoElementIds.add(element.id);
    }
  }
  const agentIds = new Set<string>([
    ...(options.stage?.generatedAgentConfigs?.map((agent) => agent.id) ?? []),
    ...(options.stage?.agentIds ?? []),
  ]);

  for (const scene of scenes) {
    const ownElementIds = new Set(canvasElements(scene).map((element) => element.id));
    const actions = (scene.actions ?? []) as readonly Action[];
    for (const action of actions) {
      const identity = {
        sceneId: scene.id,
        ...(typeof action.id === 'string' && action.id !== '' ? { actionId: action.id } : {}),
        actionType: typeof action.type === 'string' ? action.type : undefined,
      };

      // 1. Identity — a non-empty string id.
      if (typeof action.id !== 'string' || action.id === '') {
        findings.push({
          ...identity,
          actionId: undefined,
          code: 'ACTION_STRUCTURE_INVALID',
          path: '/id',
          message: `the Action on scene ${JSON.stringify(scene.id)} has an empty or missing id`,
        });
        continue;
      }

      // 2. Canonical type (TAE-RQ-004/034).
      if (!isActionType(action.type)) {
        if (options.allowUnknownTypes) continue;
        findings.push({
          ...identity,
          code: 'ACTION_TYPE_UNKNOWN',
          message:
            `scene ${JSON.stringify(scene.id)} carries Action ${JSON.stringify(action.id)} of unknown type ` +
            `${JSON.stringify(action.type)}: it must be removed or explicitly replaced with one or more canonical ` +
            `current OpenMAIC Actions in this successor`,
        });
        continue;
      }

      // 3. Variant structure — the DSL's own validator, per finding.
      const structural = validateAction(action as unknown as Parameters<typeof validateAction>[0]);
      if (!structural.valid) {
        for (const issue of structural.errors) {
          findings.push({
            ...identity,
            code: 'ACTION_STRUCTURE_INVALID',
            path: issue.path || undefined,
            message: `Action ${JSON.stringify(action.id)} on scene ${JSON.stringify(scene.id)} is structurally invalid (${issue.message})`,
          });
        }
        continue;
      }

      // 4. The four deterministic references (§9.2) — the three exclusions
      //    (speech.audioId, wb_* element targets, widget_*.target) are
      //    deliberately absent; see the module doc comment.
      const record = action as unknown as Record<string, unknown>;
      const elementRef = (type: string): void => {
        const elementId = record.elementId;
        if (typeof elementId !== 'string' || ownElementIds.has(elementId)) return;
        findings.push({
          ...identity,
          code: 'ACTION_REFERENCE_INVALID',
          path: '/elementId',
          category: 'element',
          message: `${type} on scene ${JSON.stringify(scene.id)} references element ${JSON.stringify(elementId)}, which is not in the scene's canvas`,
        });
      };
      if (action.type === 'spotlight' || action.type === 'laser') elementRef(action.type);
      if (action.type === 'play_video') {
        const elementId = record.elementId;
        if (typeof elementId === 'string' && !videoElementIds.has(elementId)) {
          findings.push({
            ...identity,
            code: 'ACTION_REFERENCE_INVALID',
            path: '/elementId',
            category: 'media',
            message: `play_video on scene ${JSON.stringify(scene.id)} references ${JSON.stringify(elementId)}, which is not a video element of any slide scene`,
          });
        }
      }
      if (action.type === 'discussion') {
        const agentId = record.agentId;
        if (typeof agentId === 'string' && !agentIds.has(agentId)) {
          findings.push({
            ...identity,
            code: 'ACTION_REFERENCE_INVALID',
            path: '/agentId',
            category: 'agent',
            message: `discussion on scene ${JSON.stringify(scene.id)} references agent ${JSON.stringify(agentId)}, which is not in the stage roster`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Kafuo Release 1 defers generated games (decision 2 Oct 2026).
 *
 * Kafuo's Teaching Engine path generates no `interactive` scene with
 * `widgetType: 'game'`. The restriction is scoped to Kafuo package work; the
 * reusable OpenMAIC game capability (generation, rendering, the drag runtime)
 * stays intact for every other caller, and historical packages, approved
 * versions and pinned learner sessions keep rendering their games.
 *
 * Where it is enforced (each refuses with `GAME_GENERATION_DEFERRED`):
 *
 * - the Kafuo generate and resume routes refuse a request whose flow requires
 *   or allows a game ({@link assertKafuoFlowWithoutGames}) before any attempt
 *   state changes — older paused attempts started under g5.v2–v5 included; their
 *   retained snapshots are read, never rewritten, and abandon still works;
 * - the runner re-asserts it before any generation work, and runs every Kafuo
 *   attempt with `prohibitedWidgetTypes: KAFUO_DEFERRED_WIDGET_TYPES`, so a game
 *   the model plans anyway (initial, re-asked, corrected or resumed outlines) is
 *   reported, and a scene that would still build one is refused before any
 *   widget model call;
 * - the editor's `generate_scene` tool refuses a game on a Kafuo package Stage;
 * - Submit for Review refuses a game Scene at a position whose own pinned
 *   policy-carrying flow does not permit one ({@link findGameScenesOutsideFlow}).
 *
 * Kafuo (`app/modules/teaching_engine/domain/game_deferral.py`) holds the same
 * predicate and refuses first; neither side relies on the other.
 */
import { scenePolicyFor, type WidgetType } from '@openmaic/generation';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { LEGACY_TENANT_ID } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

/** The widget types Kafuo Release 1 does not generate. */
export const KAFUO_DEFERRED_WIDGET_TYPES: readonly WidgetType[] = Object.freeze(['game']);

export interface FlowGamePosition {
  flowIndex: number;
  stage: string;
}

/**
 * True when a game may fill this flow position: its own scene policy, else the
 * legacy stage rules (`lesson_learning_game` for g5.v2–v4), allow `interactive`
 * with no widget restriction or with a deferred widget type.
 */
export function positionPermitsDeferredWidget(
  entry: Pick<TeachingFlowEntry, 'stage' | 'scenePolicy'>,
): boolean {
  const policy = scenePolicyFor(entry);
  if (!policy || !policy.sceneTypes.includes('interactive')) return false;
  const widgets = policy.widgetTypes;
  return !widgets || widgets.some((widget) => KAFUO_DEFERRED_WIDGET_TYPES.includes(widget));
}

/** The flow positions that require or allow a game. */
export function flowGamePositions(
  flow: ReadonlyArray<Pick<TeachingFlowEntry, 'stage' | 'scenePolicy'>>,
): FlowGamePosition[] {
  const positions: FlowGamePosition[] = [];
  flow.forEach((entry, flowIndex) => {
    if (positionPermitsDeferredWidget(entry)) positions.push({ flowIndex, stage: entry.stage });
  });
  return positions;
}

/**
 * Refuse a Kafuo request whose Teaching Model Flow requires or allows a game.
 * `operation` only shapes the guidance: a new generation is told to adopt the
 * game-free Teaching Model version; a resume is told to abandon the attempt.
 */
export function assertKafuoFlowWithoutGames(
  teachingModel: { key: string; version: string; flow: readonly TeachingFlowEntry[] },
  operation: 'generate' | 'resume' | 'run',
): void {
  const positions = flowGamePositions(teachingModel.flow);
  if (positions.length === 0) return;
  const where = positions
    .map((position) => `${position.flowIndex} ("${position.stage}")`)
    .join(', ');
  const guidance =
    operation === 'resume'
      ? 'This paused attempt was started under that flow and cannot be resumed: abandon it, then generate again under the game-free Teaching Model version.'
      : 'Assign the game-free Teaching Model version in Kafuo, then generate again.';
  throw new TeachingPackageError(
    'GAME_GENERATION_DEFERRED',
    `Kafuo Release 1 does not generate learning games, and Teaching Model ${teachingModel.key}/${teachingModel.version} requires or allows a generated game at flow position ${where}. ${guidance}`,
    {
      teachingModel: { key: teachingModel.key, version: teachingModel.version },
      gamePositions: positions,
    },
  );
}

/** The widget type an interactive Scene renders, when it has one. */
function sceneWidgetType(scene: AppScene): string | undefined {
  if (scene.type !== 'interactive') return undefined;
  const content = scene.content as { widgetType?: unknown } | undefined;
  return typeof content?.widgetType === 'string' ? content.widgetType : undefined;
}

/**
 * The game Scenes of a policy-carrying flow (g5.v5+) that sit at a position
 * whose own policy does not permit a game — an editor-inserted game in a g5.v6
 * package, for instance. A g5.v5 draft's game at its own game position is
 * history and passes; flows without scene policies (g5.v1–v4) are not checked
 * here, exactly as before.
 */
export function findGameScenesOutsideFlow(
  scenes: readonly AppScene[],
  flow: readonly TeachingFlowEntry[],
): string[] {
  if (!flow.some((entry) => entry.scenePolicy !== undefined)) return [];
  return scenes
    .filter((scene) => {
      const widgetType = sceneWidgetType(scene);
      if (!widgetType || !KAFUO_DEFERRED_WIDGET_TYPES.includes(widgetType as WidgetType)) {
        return false;
      }
      const position = scene.teachingStage;
      const entry =
        position && Number.isInteger(position.flowIndex) ? flow[position.flowIndex] : undefined;
      return !entry || entry.stage !== position?.key || !positionPermitsDeferredWidget(entry);
    })
    .map((scene) => scene.id);
}

/**
 * True when the Stage is bound to a Kafuo Teaching Package version (any tenant
 * but the legacy namespace). Used by editor tools, which know a Stage only.
 */
export async function isKafuoPackageStage(stageId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL);
  const result = await pool.query(
    `SELECT 1 FROM teaching_package_versions WHERE current_stage_id = $1 AND tenant_id <> $2 LIMIT 1`,
    [stageId, LEGACY_TENANT_ID],
  );
  return result.rows.length > 0;
}

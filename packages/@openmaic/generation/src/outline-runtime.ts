/**
 * Scene-runtime integrity for generated outlines: a quiz / interactive / pbl
 * experience the plan requires is never turned into a static slide.
 *
 * Three ways a plan can fail to deliver a runtime scene, and what each means:
 *
 * - **Malformed plan** — an `interactive` outline with no widget/interactive
 *   config, or a `pbl` outline with no `pblConfig`. A bad model answer: it is
 *   reported as an outline-gate issue so the caller's bounded re-roll applies,
 *   and the scene KEEPS its type. After the re-roll is exhausted the failure is
 *   the typed `OUTLINE_SCENE_CONFIG_INVALID`.
 * - **Unavailable runtime** — the plan requires a family this server cannot
 *   run (no language model for PBL, a family disabled by configuration). A
 *   typed, non-retryable planning conflict `SCENE_RUNTIME_UNAVAILABLE`.
 * - **Hard cap exceeded** — an operator-configured hard limit is lower than the
 *   number of runtime scenes the lesson requires. A typed, non-retryable
 *   planning conflict `SCENE_CAP_CONFLICT`. No hard limit exists by default.
 *
 * Nothing here ever changes an outline's `type`. Pure: no I/O, no logging.
 */
import type { SceneOutline } from './outline-types.js';

export const OUTLINE_SCENE_CONFIG_ERROR = 'OUTLINE_SCENE_CONFIG_INVALID';
export const SCENE_RUNTIME_UNAVAILABLE = 'SCENE_RUNTIME_UNAVAILABLE';
export const SCENE_CAP_CONFLICT = 'SCENE_CAP_CONFLICT';

/** The scene families that need a runtime beyond the slide renderer. */
export type RuntimeSceneFamily = 'interactive' | 'pbl';

/**
 * Which runtime families this generation can deliver. Absent means available;
 * `quiz` is always available and is not listed.
 */
export interface AvailableSceneRuntimes {
  interactive?: boolean;
  pbl?: boolean;
}

/** Operator-configured hard limits per family. None is set by default. */
export type SceneHardLimits = Partial<Record<RuntimeSceneFamily, number>>;

export interface OutlineSceneConfigIssue {
  /** Zero-based position of the offending outline. */
  index: number;
  message: string;
}

/** A malformed runtime-scene plan that survived the bounded re-roll. */
export class OutlineSceneConfigError extends Error {
  readonly code = OUTLINE_SCENE_CONFIG_ERROR;
  constructor(readonly issues: OutlineSceneConfigIssue[]) {
    super(formatOutlineSceneConfigIssues(issues));
    this.name = 'OutlineSceneConfigError';
  }
}

/** The plan requires a runtime family this generation cannot deliver. */
export class SceneRuntimeUnavailableError extends Error {
  readonly code = SCENE_RUNTIME_UNAVAILABLE;
  readonly retryable = false;
  constructor(
    readonly sceneIndex: number,
    readonly requiredType: RuntimeSceneFamily,
    readonly reason: string,
  ) {
    super(
      `${SCENE_RUNTIME_UNAVAILABLE}: scene #${sceneIndex} requires the "${requiredType}" runtime, which is unavailable (${reason}); it is not converted to a slide`,
    );
    this.name = 'SceneRuntimeUnavailableError';
  }
}

/** The lesson requires more runtime scenes than a configured hard limit allows. */
export class SceneCapConflictError extends Error {
  readonly code = SCENE_CAP_CONFLICT;
  readonly retryable = false;
  constructor(
    readonly family: RuntimeSceneFamily,
    readonly required: number,
    readonly limit: number,
  ) {
    super(
      `${SCENE_CAP_CONFLICT}: the lesson requires ${required} "${family}" scene(s) but the configured hard limit is ${limit}; raise the limit or narrow the lesson scope — scenes are never trimmed or converted`,
    );
    this.name = 'SceneCapConflictError';
  }
}

function hasWidgetConfig(outline: SceneOutline): boolean {
  return Boolean(outline.widgetType && outline.widgetOutline);
}

/** The config problem of one outline, or `undefined` when it is well-formed. */
function sceneConfigProblem(outline: SceneOutline): string | undefined {
  if (outline?.type === 'interactive' && !outline.interactiveConfig && !hasWidgetConfig(outline)) {
    return 'scene is "interactive" but has no widgetType + widgetOutline (or interactiveConfig); keep it interactive and supply its config';
  }
  if (outline?.type === 'pbl' && !outline.pblConfig) {
    return 'scene is "pbl" but has no pblConfig; keep it pbl and supply its config';
  }
  return undefined;
}

/** Report every runtime outline that lacks the config its family needs. */
export function validateOutlineSceneConfigs(outlines: SceneOutline[]): OutlineSceneConfigIssue[] {
  const issues: OutlineSceneConfigIssue[] = [];
  outlines.forEach((outline, index) => {
    const message = sceneConfigProblem(outline);
    if (message) issues.push({ index, message });
  });
  return issues;
}

/** One-line failure message for a plan with malformed runtime scenes. */
export function formatOutlineSceneConfigIssues(issues: OutlineSceneConfigIssue[]): string {
  const shown = issues
    .slice(0, 5)
    .map((issue) => `#${issue.index} ${issue.message}`)
    .join('; ');
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
  return `${OUTLINE_SCENE_CONFIG_ERROR}: ${issues.length} scene config issue(s): ${shown}${more}`;
}

/** Throw the typed conflict if any outline requires an unavailable runtime. */
export function assertSceneRuntimesAvailable(
  outlines: SceneOutline[],
  available: AvailableSceneRuntimes = {},
  reasons: Partial<Record<RuntimeSceneFamily, string>> = {},
): void {
  outlines.forEach((outline, index) => {
    const family = outline?.type;
    if ((family === 'interactive' || family === 'pbl') && available[family] === false) {
      throw new SceneRuntimeUnavailableError(
        index,
        family,
        reasons[family] ?? 'disabled for this generation',
      );
    }
  });
}

/** Throw the typed conflict if required runtime scenes exceed a hard limit. */
export function assertSceneHardLimits(
  outlines: SceneOutline[],
  limits: SceneHardLimits = {},
): void {
  for (const family of ['interactive', 'pbl'] as const) {
    const limit = limits[family];
    if (typeof limit !== 'number') continue;
    const required = outlines.filter((outline) => outline?.type === family).length;
    if (required > limit) throw new SceneCapConflictError(family, required, limit);
  }
}

/** The prompt text naming the unavailable families; empty when all are available. */
export function describeUnavailableRuntimes(available: AvailableSceneRuntimes = {}): string {
  return (['interactive', 'pbl'] as const)
    .filter((family) => available[family] === false)
    .map((family) => `\`${family}\``)
    .join(' and ');
}

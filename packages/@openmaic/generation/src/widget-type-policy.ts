/**
 * Prohibited interactive widget types — a caller-declared, per-generation
 * restriction (e.g. Kafuo Release 1 defers generated games).
 *
 * The package keeps every widget capability; a caller that must not generate a
 * widget type names it in `prohibitedWidgetTypes`, and the same reading of an
 * outline is applied at every point a widget could still come into being:
 *
 * - the outline prompt is told the widget cannot be delivered (and must not be
 *   disguised as another scene type);
 * - the outline check reports an interactive outline that would build it as an
 *   admin-correctable `WIDGET_TYPE_PROHIBITED` finding (never repaired: the
 *   scene type is not changed by a machine);
 * - scene content generation refuses it with {@link WidgetTypeProhibitedError}
 *   BEFORE any widget model call.
 *
 * "Would build it" follows the scene generator exactly: an explicit
 * `widgetType`, else the type inferred from a legacy `interactiveConfig`, else
 * the `simulation` fallback ({@link interactiveWidgetTypeOf}).
 *
 * Absent or empty → nothing is checked and every prompt renders byte-identically.
 * Pure: no I/O, no logging.
 */
import type { OutlineDiagnostic } from './outline-diagnostics.js';
import type { SceneOutline, WidgetType } from './outline-types.js';

export const WIDGET_TYPE_PROHIBITED = 'WIDGET_TYPE_PROHIBITED';

/** A scene content request for a widget type this generation must not build. */
export class WidgetTypeProhibitedError extends Error {
  readonly code = WIDGET_TYPE_PROHIBITED;
  readonly retryable = false;
  constructor(
    readonly widgetType: WidgetType,
    readonly sceneTitle: string,
  ) {
    super(
      `${WIDGET_TYPE_PROHIBITED}: scene ${JSON.stringify(sceneTitle)} would build a "${widgetType}" widget, which cannot be generated for this course`,
    );
    this.name = 'WidgetTypeProhibitedError';
  }
}

/**
 * Infer a widget type from a legacy `interactiveConfig`'s free text. Moved
 * verbatim from the scene generator so the outline check and the generator
 * read a legacy config the same way.
 */
export function inferWidgetType(subject: string, concept: string, designIdea: string): WidgetType {
  const text = (subject + ' ' + concept + ' ' + designIdea).toLowerCase();

  // Rule-based inference
  if (
    /physics|chemistry|力学|化学|运动|反应|force|motion|equilibrium|wave|电路|circuit/.test(text)
  ) {
    return 'simulation';
  }
  if (/programming|code|algorithm|编程|算法|python|javascript|function|代码/.test(text)) {
    return 'code';
  }
  if (/process|workflow|步骤|流程|逻辑|step|flow|系统|system/.test(text)) {
    return 'diagram';
  }
  if (
    /biology|anatomy|cell|molecular|生物|细胞|分子|3d|三维|solar|planet|skeleton|organ/.test(text)
  ) {
    return 'visualization3d';
  }
  if (/game|quiz|practice|练习|游戏|puzzle|match|challenge|挑战/.test(text)) {
    return 'game';
  }

  // Default fallback
  return 'simulation';
}

/** The widget type the scene generator would build for an outline; `undefined` for non-interactive. */
export function interactiveWidgetTypeOf(outline: SceneOutline): WidgetType | undefined {
  if (outline?.type !== 'interactive') return undefined;
  if (outline.widgetType) return outline.widgetType;
  const config = outline.interactiveConfig;
  if (config) {
    return inferWidgetType(config.subject || '', config.conceptName, config.designIdea || '');
  }
  return 'simulation';
}

/** True when the outline would build a widget type in `prohibited`. */
export function isProhibitedWidgetOutline(
  outline: SceneOutline,
  prohibited: readonly WidgetType[] | undefined,
): boolean {
  if (!prohibited || prohibited.length === 0) return false;
  const widgetType = interactiveWidgetTypeOf(outline);
  return widgetType !== undefined && prohibited.includes(widgetType);
}

/** One admin-correctable finding per outline that would build a prohibited widget. */
export function prohibitedWidgetDiagnostics(
  outlines: readonly SceneOutline[],
  prohibited: readonly WidgetType[] | undefined,
): OutlineDiagnostic[] {
  if (!prohibited || prohibited.length === 0) return [];
  const diagnostics: OutlineDiagnostic[] = [];
  outlines.forEach((outline, outlineIndex) => {
    if (!isProhibitedWidgetOutline(outline, prohibited)) return;
    const widgetType = interactiveWidgetTypeOf(outline)!;
    diagnostics.push({
      code: WIDGET_TYPE_PROHIBITED,
      disposition: 'admin_correctable',
      outlineIndex,
      ...(outline.id ? { outlineId: outline.id } : {}),
      field: outline.widgetType ? 'widgetType' : 'type',
      ...(outline.teachingStage
        ? { flowIndex: outline.teachingStage.flowIndex, stage: outline.teachingStage.key }
        : {}),
      message: `outline #${outlineIndex + 1} (${JSON.stringify(outline.id)}) is an interactive "${widgetType}" scene, which cannot be generated for this course; remove it or plan the scene its flow position requires — never the same experience restated as a quiz, slide or another widget`,
    });
  });
  return diagnostics;
}

/** The prompt text naming the prohibited widget types; empty when none. */
export function describeProhibitedWidgetTypes(prohibited: readonly WidgetType[] = []): string {
  return prohibited.map((widgetType) => `\`${widgetType}\``).join(' and ');
}

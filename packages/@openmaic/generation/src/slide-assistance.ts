/**
 * Assistance authoring — step 2 of slide generation.
 *
 * ```
 * (1) canvas      inputs: learner-visible content + planner guidance      → SlideContent.canvas
 * (2) assistance  inputs: AssistancePlan + the task text AS RENDERED by (1) → SlideContent.assistance
 * (3) narration   inputs: the visible canvas + role guidance              → actions
 * ```
 *
 * The solution path reaches exactly one model call — this one. It is fed the
 * hidden {@link AssistancePlan} and the visible task text, and nothing it
 * produces flows back into canvas or narration generation. Runs only when the
 * outline plans assistance.
 */
import { SLIDE_ASSISTANCE_TIERS, type PPTElement, type SlideAssistance } from '@openmaic/dsl';
import { parseJsonResponse } from './json-repair.js';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';
import type { AssistancePlan } from './outline-types.js';
import type { AICallFn } from './pipeline-types.js';
import { buildPrompt, PROMPT_IDS } from './prompts/index.js';
import type { PlannerGuidance } from './slide-generation-inputs.js';

/** Tags an assistance tier may carry — the prose subset the renderers manage. */
const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'ol', 'ul', 'li', 'br', 'sub', 'sup']);

/**
 * Reduce model-written HTML to the allowed formatting tags, with no attributes.
 * A first line of defence only: the app's persistence boundary re-applies its
 * full allowlist sanitiser to `SlideContent.assistance`.
 */
export function sanitizeAssistanceHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (tag, name: string) => {
      const lower = name.toLowerCase();
      if (!ALLOWED_TAGS.has(lower)) return '';
      return tag.startsWith('</') ? `</${lower}>` : lower === 'br' ? '<br>' : `<${lower}>`;
    })
    .trim();
}

/** Plain text of one canvas element, tags stripped; empty when it has none. */
function elementText(element: PPTElement): string {
  const record = element as unknown as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.content === 'string') parts.push(record.content);
  const shapeText = record.text as { content?: unknown } | undefined;
  if (shapeText && typeof shapeText.content === 'string') parts.push(shapeText.content);
  if (typeof record.latex === 'string') parts.push(record.latex);
  if (Array.isArray(record.data)) {
    for (const row of record.data as unknown[]) {
      if (!Array.isArray(row)) continue;
      for (const cell of row as Array<{ text?: unknown }>) {
        if (cell && typeof cell.text === 'string') parts.push(cell.text);
      }
    }
  }
  return parts
    .map((part) =>
      part
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');
}

/** The learner-visible text of a generated canvas, in element order. */
export function visibleCanvasText(elements: PPTElement[]): string {
  return elements
    .map((element) => elementText(element))
    .filter(Boolean)
    .join('\n');
}

export interface SlideAssistanceOptions {
  languageDirective?: string;
  logger?: GenerationLogger;
}

/**
 * Author `SlideContent.assistance` from the hidden plan and the task as the
 * learner sees it. Returns `undefined` when the model produced no usable tier —
 * the caller decides whether that fails the slide (it does for independent
 * practice, via the strict validator).
 */
export async function generateSlideAssistance(
  plan: AssistancePlan,
  task: { title: string; elements: PPTElement[] },
  guidance: Pick<PlannerGuidance, 'contentRole' | 'contentKind'>,
  aiCall: AICallFn,
  options: SlideAssistanceOptions = {},
): Promise<SlideAssistance | undefined> {
  const log = options.logger ?? noopGenerationLogger;
  const tiers = SLIDE_ASSISTANCE_TIERS.filter((tier) => plan[tier] !== undefined);
  if (tiers.length === 0) return undefined;

  const prompts = buildPrompt(PROMPT_IDS.SLIDE_ASSISTANCE, {
    title: task.title,
    taskText: visibleCanvasText(task.elements) || task.title,
    assistancePlanText: tiers.map((tier) => `- ${tier}: ${plan[tier]}`).join('\n'),
    tiers: tiers.map((tier) => `- ${tier}`).join('\n'),
    languageDirective: options.languageDirective || '',
    reasoningSupport:
      guidance.contentRole === 'practice' && guidance.contentKind === 'higher_order',
    lightweightSupport: guidance.contentRole === 'check_understanding',
  });
  if (!prompts) return undefined;

  const response = await aiCall(prompts.system, prompts.user);
  const parsed = parseJsonResponse<Record<string, unknown>>(response);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.error(`Failed to parse slide assistance for: ${task.title}`);
    return undefined;
  }

  const assistance: SlideAssistance = {};
  for (const tier of tiers) {
    const value = parsed[tier];
    if (typeof value !== 'string') continue;
    const html = sanitizeAssistanceHtml(value);
    if (html !== '') assistance[tier] = html;
  }
  return Object.keys(assistance).length > 0 ? assistance : undefined;
}

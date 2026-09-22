/**
 * Defence in depth for learner-only content. The PRIMARY protection is
 * structural: internal information is never placed where display content is
 * produced from (see `./slide-generation-inputs.ts`). These checks exist only
 * to catch a regression in those structural measures — they are not the
 * boundary.
 *
 * The scanner flags UNAMBIGUOUS internal identifiers only. Ordinary words such
 * as "example", "summary" or "practice" are legitimate instructional language
 * and are never flagged.
 */

/** Identifiers that can only come from the contract, a prompt, or a schema. */
const INTERNAL_IDENTIFIERS = [
  'contentRole',
  'contentKind',
  'slideType',
  'assistancePlan',
  'keyPoints',
  'teachingSkills',
  'teachingStage',
  'worked_example',
  'check_understanding',
  'source_analysis',
  'higher_order',
  'PLANNING GUIDANCE',
  'LEARNER CONTENT',
] as const;

const INTERNAL_PATTERN = new RegExp(
  `(?:${INTERNAL_IDENTIFIERS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
);
/** An unresolved prompt placeholder. */
const PLACEHOLDER_PATTERN = /\{\{\s*[\w#/:-]+[^}]*\}\}/;

/** The internal identifiers / unresolved placeholders found in `texts`. */
export function findInternalLeaks(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const token = INTERNAL_PATTERN.exec(text);
    if (token) found.add(token[0]);
    const placeholder = PLACEHOLDER_PATTERN.exec(text);
    if (placeholder) found.add(placeholder[0]);
  }
  return [...found];
}

function normalize(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * True when the hidden full explanation has visibly leaked onto the canvas:
 * at least half of its substantial sentences appear verbatim in the visible
 * text. Deterministic and deliberately conservative — a task restated inside
 * the explanation is a single sentence and does not trip it.
 */
export function explanationLeakedOntoCanvas(explanation: string, canvasText: string): boolean {
  const visible = normalize(canvasText);
  const sentences = normalize(explanation)
    .split(/(?<=[.!?؟。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25);
  if (sentences.length < 2 || visible === '') return false;
  const leaked = sentences.filter((sentence) => visible.includes(sentence)).length;
  return leaked / sentences.length >= 0.5;
}

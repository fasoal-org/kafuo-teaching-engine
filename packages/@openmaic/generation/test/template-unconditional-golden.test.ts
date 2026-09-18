/**
 * Permanent source pin for the UNCONDITIONAL content of the six scene
 * templates that carry a `{{#if hasSkillContext}}` block (Module 2 W11).
 *
 * Why this pin exists: in W11 a word was accidentally dropped from
 * slide-actions' unconditional "Important Notes" ("…its corresponding text
 * object" became "…its corresponding text") while appending the conditional
 * block, and nothing caught it — the only rendered pin for the action prompts
 * (scene-skill-context.test.ts) was born in the same commit, so its baseline
 * captured the drifted bytes: a circular snapshot. Rendered goldens born in a
 * later wave can only detect drift RELATIVE to their own birth, never relative
 * to the pre-conditional content.
 *
 * This guard pins the template SOURCE directly: strip each template's
 * conditional-family blocks and compare the remainder byte-for-byte against
 * the stored golden in test/template-unconditional-golden/. The stored text is
 * readable raw text — deliberately NOT a digest — because the failure mode of
 * record is a dropped word, and a digest would report an opaque mismatch
 * instead of the word.
 *
 * Baseline provenance (non-circular): seeded on 2026-09-18 from the live
 * templates AFTER a mechanical strip-and-diff against pre-W11 commit 4a223e67
 * reported all six templates IDENTICAL (the "text object" restoration). Any
 * edit to unconditional template content — in any wave, however its snapshots
 * were born — fails here with a readable diff.
 *
 * Module 3/4 W1 generalized the recipe WITHOUT re-seeding any golden: the
 * four action templates gained a second conditional family member,
 * `{{#if hasFlowContext}}`, inserted immediately before the Skill block so the
 * two conditionals form one unbroken conditional tail. The strip now cuts from
 * the FIRST marker of either family; the bytes before that first marker are
 * exactly the bytes the W11 goldens pinned, so the six stored files stay
 * byte-unchanged and their pre-W11 provenance survives.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(PKG_ROOT, 'test', 'template-unconditional-golden');
const CLOSING = '{{/if}}';

/** The conditional-family markers, in template order when both are present. */
const FAMILY_MARKERS = ['{{#if hasFlowContext}}', '{{#if hasSkillContext}}'] as const;

const TEMPLATES = [
  'slide-actions',
  'interactive-actions',
  'slide-content',
  'quiz-content',
  'quiz-actions',
  'pbl-actions',
] as const;

/** The four action templates carry the W1 Flow block; the content ones do not. */
const FLOW_CARRYING: readonly string[] = [
  'slide-actions',
  'quiz-actions',
  'interactive-actions',
  'pbl-actions',
];

/**
 * Strip the template's conditional-family blocks and return the unconditional
 * remainder, trailing whitespace normalized (the prompt loader trims templates,
 * so trailing bytes are rendering-invisible; the pin guards word-level
 * content). Throws — failing the test — if the recipe preconditions do not
 * hold, so the pin can never silently degrade into comparing a malformed
 * strip: each family marker appears EXACTLY ONCE in the templates that carry
 * it, the conditionals form one unbroken tail (nothing unconditional between
 * or after them), and the tail ends with `{{/if}}`.
 */
function stripConditionalFamily(template: (typeof TEMPLATES)[number]): string {
  const text = readFileSync(join(PKG_ROOT, 'templates', template, 'system.md'), 'utf-8');

  const indices: number[] = [];
  for (const marker of FAMILY_MARKERS) {
    const count = text.split(marker).length - 1;
    const expected =
      marker === '{{#if hasSkillContext}}' || FLOW_CARRYING.includes(template) ? 1 : 0;
    expect(
      count,
      `${template}: exactly one ${marker} (this template carries it: ${expected === 1})`,
    ).toBe(expected);
    if (count === 1) indices.push(text.indexOf(marker));
  }

  const first = Math.min(...indices);
  const tail = text.slice(first).trimEnd();
  expect(tail.endsWith(CLOSING), `${template}: the conditional family is the file's tail`).toBe(
    true,
  );
  // One unbroken conditional tail: after the FIRST family block closes, the
  // next family marker (when the template carries one) follows with NOTHING
  // in between — unconditional text cannot hide between the two blocks.
  const firstClose = tail.indexOf(CLOSING);
  const betweenAndAfter = tail.slice(firstClose + CLOSING.length);
  const remainingMarkers = FAMILY_MARKERS.filter((marker) => betweenAndAfter.includes(marker));
  if (remainingMarkers.length > 0) {
    const nextMarker = betweenAndAfter.indexOf(remainingMarkers[0]!);
    expect(
      betweenAndAfter.slice(0, nextMarker),
      `${template}: nothing between the conditional blocks`,
    ).toBe('');
  }
  return `${text.slice(0, first).replace(/\s+$/, '')}\n`;
}

describe('unconditional scene-template content is pinned at the source', () => {
  for (const template of TEMPLATES) {
    it(`strips the conditional family from ${template} and matches the golden exactly`, () => {
      const golden = readFileSync(join(GOLDEN_DIR, `${template}.txt`), 'utf-8');
      expect(stripConditionalFamily(template)).toBe(golden);
    });
  }

  it('pins all six W11 templates (the guard stays scoped to the conditional family)', () => {
    // Six templates carry the Skill block today; if one is added or removed,
    // this count changes on purpose and the golden set must be re-seeded
    // through review — never silently.
    expect(TEMPLATES).toHaveLength(6);
  });
});

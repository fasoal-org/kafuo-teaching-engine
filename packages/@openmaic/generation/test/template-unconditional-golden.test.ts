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
 * This guard pins the template SOURCE directly: strip each template's single
 * `hasSkillContext` conditional block and compare the remainder byte-for-byte
 * against the stored golden in test/template-unconditional-golden/. The stored
 * text is readable raw text — deliberately NOT a digest — because the failure
 * mode of record is a dropped word, and a digest would report an opaque
 * mismatch instead of the word.
 *
 * Baseline provenance (non-circular): seeded on 2026-09-18 from the live
 * templates AFTER a mechanical strip-and-diff against pre-W11 commit 4a223e67
 * reported all six templates IDENTICAL (the "text object" restoration). Any
 * edit to unconditional template content — in any wave, however its snapshots
 * were born — fails here with a readable diff.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = join(PKG_ROOT, 'test', 'template-unconditional-golden');
const MARKER = '{{#if hasSkillContext}}';
const CLOSING = '{{/if}}';

const TEMPLATES = [
  'slide-actions',
  'interactive-actions',
  'slide-content',
  'quiz-content',
  'quiz-actions',
  'pbl-actions',
] as const;

/**
 * Strip the template's single `hasSkillContext` conditional block and return
 * the unconditional remainder, trailing whitespace normalized (the prompt
 * loader trims templates, so trailing bytes are rendering-invisible; the pin
 * guards word-level content). Throws — failing the test — if the recipe
 * preconditions do not hold, so the pin can never silently degrade into
 * comparing a malformed strip.
 */
function stripSkillContextBlock(template: (typeof TEMPLATES)[number]): string {
  const text = readFileSync(join(PKG_ROOT, 'templates', template, 'system.md'), 'utf-8');
  const count = text.split(MARKER).length - 1;
  expect(count, `${template}: exactly one hasSkillContext marker`).toBe(1);
  const index = text.indexOf(MARKER);
  const tail = text.slice(index).trimEnd();
  expect(tail.endsWith(CLOSING), `${template}: the conditional block is the file's tail`).toBe(
    true,
  );
  return `${text.slice(0, index).replace(/\s+$/, '')}\n`;
}

describe('unconditional scene-template content is pinned at the source', () => {
  for (const template of TEMPLATES) {
    it(`strips the hasSkillContext block from ${template} and matches the golden exactly`, () => {
      const golden = readFileSync(join(GOLDEN_DIR, `${template}.txt`), 'utf-8');
      expect(stripSkillContextBlock(template)).toBe(golden);
    });
  }

  it('pins all six W11 templates (the guard stays scoped to the hasSkillContext family)', () => {
    // Six templates carry the block today; if one is added or removed, this
    // count changes on purpose and the golden set must be re-seeded through
    // review — never silently.
    expect(TEMPLATES).toHaveLength(6);
  });
});

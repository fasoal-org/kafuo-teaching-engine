/**
 * The LLM-facing side of the Kafuo authority model.
 *
 * Content Units are the pedagogical authority the model is given and asked to
 * cite. Document Blocks are internal extraction/provenance records: they stay
 * on `PdfImage` and in the selected-visual manifest, but no block id is ever
 * rendered into a prompt, and no outline is ever asked to return one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildOutlinePrompt } from '../src/outline-generator.js';
import { formatImageDescription, formatImagePlaceholder } from '../src/outline-formatters.js';
import { formatImageDescription as formatSceneImageDescription } from '../src/prompt-formatters.js';
import type { PdfImage } from '../src/outline-types.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'outline-prompt-golden');
const golden = (name: string) => readFileSync(join(GOLDEN_DIR, `${name}.txt`), 'utf-8');

const REQUIREMENT = { requirement: 'Teach photosynthesis' };
const PLAIN_IMAGE: PdfImage = {
  id: 'img_1',
  src: 'data:image/png;base64,AA',
  pageNumber: 2,
  width: 100,
  height: 50,
  description: 'a leaf',
};
const FLOW = [{ stage: 'lesson_introduction', instructions: 'Open the lesson' }];
const NORMALIZED_TEXT =
  '[[CONTENT_UNIT id=2900 order=0 role=INSTRUCTIONAL]]\nTITLE: Light\napproved text\n[[/CONTENT_UNIT]]';

/** A Kafuo normalized visual: associated to a Content Unit, backed by a Block. */
const NORMALIZED_IMAGE: PdfImage = {
  id: 'src-1',
  src: 'data:image/png;base64,AA',
  pageNumber: 2,
  width: 800,
  height: 600,
  sourceContentUnitIds: ['2900', '2901'],
  sourceBlockIds: ['51061'],
  sourceRole: 'EXPLANATION',
  figureLabel: 'Figure 1.2',
  caption: 'A leaf cross-section',
  visionPriority: 5,
};

describe('non-normalized outline prompts are unchanged', () => {
  // The golden files are the prompt bytes from BEFORE the grounding contract
  // existed. The conditional blocks are written so a false condition consumes
  // its own newline — a stray blank line here would be a real regression for
  // every PDF and non-Kafuo course.
  it('renders the PDF prompt byte-for-byte as before', () => {
    const prompts = buildOutlinePrompt(REQUIREMENT, {
      pdfText: 'some pdf text',
      pdfImages: [PLAIN_IMAGE],
    });
    expect(prompts.system).toBe(golden('plain-system'));
    expect(prompts.user).toBe(golden('plain-user'));
  });

  it('renders the teaching-flow prompt byte-for-byte as before', () => {
    const prompts = buildOutlinePrompt(REQUIREMENT, {
      pdfText: 'some pdf text',
      teachingFlow: FLOW,
    });
    expect(prompts.system).toBe(golden('flow-system'));
    expect(prompts.user).toBe(golden('flow-user'));
  });

  it('never mentions source grounding when the option is off', () => {
    for (const context of [
      { pdfText: 'some pdf text', pdfImages: [PLAIN_IMAGE] },
      { pdfText: 'some pdf text', teachingFlow: FLOW, normalizedGrounding: false },
    ]) {
      const prompts = buildOutlinePrompt(REQUIREMENT, context);
      expect(prompts.system).not.toContain('sourceContentUnitIds');
      expect(prompts.user).not.toContain('sourceContentUnitIds');
    }
  });

  it('treats an explicit false exactly like an absent option', () => {
    const absent = buildOutlinePrompt(REQUIREMENT, { pdfText: 'x', teachingFlow: FLOW });
    const explicit = buildOutlinePrompt(REQUIREMENT, {
      pdfText: 'x',
      teachingFlow: FLOW,
      normalizedGrounding: false,
    });
    expect(explicit).toEqual(absent);
  });
});

describe('normalized grounding prompt contract', () => {
  const grounded = () =>
    buildOutlinePrompt(REQUIREMENT, {
      pdfText: NORMALIZED_TEXT,
      normalizedGrounding: true,
      teachingFlow: FLOW,
      visionEnabled: true,
      imageMapping: { 'src-1': 'data:image/png;base64,AA' },
      pdfImages: [NORMALIZED_IMAGE],
    });

  it('requires sourceContentUnitIds in the minimum Scene JSON example', () => {
    const { system, user } = grounded();
    // Both templates carry the field where the model is most likely to copy from.
    expect(user).toContain('"sourceContentUnitIds": ["2900"]');
    expect(system).toContain('"sourceContentUnitIds": ["2900"]');
  });

  it('requires sourceContentUnitIds in the Scene field table', () => {
    const { system } = grounded();
    const row = system
      .split('\n')
      .find((line) => line.startsWith('| sourceContentUnitIds'));
    expect(row).toBeDefined();
    expect(row).toContain('✅');
  });

  it('repeats the requirement in the closing reminders', () => {
    const { system, user } = grounded();
    expect(system.slice(-1200)).toContain('sourceContentUnitIds');
    expect(user.slice(-600)).toContain('sourceContentUnitIds');
  });

  it('tells the model to copy ids exactly, use relevant ones, and invent none', () => {
    const { system } = grounded();
    expect(system).toContain('[[CONTENT_UNIT id=...]]');
    expect(system).toMatch(/copy .*exactly|Copy each id \*\*exactly\*\*/i);
    expect(system).toMatch(/one or more/i);
    expect(system).toMatch(/[Nn]ever invent an id/);
  });

  it('never asks for block ids', () => {
    const { system, user } = grounded();
    for (const prompt of [system, user]) {
      expect(prompt).not.toContain('sourceBlockIds');
      expect(prompt).not.toContain('[[BLOCK');
      // The only mentions of blocks are prohibitions ("never return block ids"),
      // never a field the model is asked to populate.
      expect(prompt).not.toMatch(/block ids?[^.\n]*\b(required|must (?:carry|include|return))/i);
    }
  });

  it('still carries the teaching-flow contract alongside grounding', () => {
    const { system } = grounded();
    expect(system).toContain('teachingStage');
    expect(system).toContain('lesson_introduction');
  });
});

describe('visual descriptions sent to the model', () => {
  it('names the associated Content Units, never the Blocks', () => {
    const description = formatImageDescription(NORMALIZED_IMAGE);
    const placeholder = formatImagePlaceholder(NORMALIZED_IMAGE);

    for (const rendered of [description, placeholder]) {
      expect(rendered).toContain('src-1');
      expect(rendered).toContain('Content Units: 2900, 2901');
      expect(rendered).toContain('page 2');
      expect(rendered).toContain('Figure: Figure 1.2');
      expect(rendered).toContain('800×600');
      // The internal block provenance is on the object and stays off the prompt.
      expect(rendered).not.toContain('51061');
      expect(rendered).not.toContain('Block');
    }
    // The vision placeholder still routes the bytes through the vision channel.
    expect(placeholder).toContain('[see attached]');
    expect(description).toContain('Caption: A leaf cross-section');
  });

  it('keeps the block provenance on the image object itself', () => {
    // Item 7: the restriction is what reaches the model, not what OpenMAIC holds.
    expect(NORMALIZED_IMAGE.sourceBlockIds).toEqual(['51061']);
  });

  it('leaves a plain PDF image description untouched', () => {
    expect(formatImageDescription(PLAIN_IMAGE)).toBe(
      '- **img_1**: from PDF page 2 | size: 100×50 (aspect ratio 2.00) | a leaf',
    );
    expect(formatImagePlaceholder(PLAIN_IMAGE)).toBe(
      '- **img_1**: image from PDF page 2 | size: 100×50 (aspect ratio 2.00) [see attached]',
    );
  });

  it('keeps block ids out of the scene-content prompt too', () => {
    // The same authority model applies to Stage 2: `prompt-formatters` feeds the
    // scene-content prompt, which is equally LLM-facing.
    const rendered = formatSceneImageDescription(NORMALIZED_IMAGE);
    expect(rendered).toContain('Content Units: 2900, 2901');
    expect(rendered).not.toContain('51061');
    expect(rendered).not.toContain('Block:');
  });
});

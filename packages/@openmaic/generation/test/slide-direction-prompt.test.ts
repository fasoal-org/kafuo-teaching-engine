/**
 * Slide layout direction is lesson metadata handed to the generator — never
 * something it works out from the slide's own text. Only an explicit 'rtl'
 * changes the prompt; 'ltr' and "unknown" keep the historical bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  generateSceneContent,
  type AICallFn,
  type SceneContentOptions,
} from '@openmaic/generation';
import { quizOutline, slideOutline } from './scene-fixtures.js';

const SLIDE_REPLY = JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } });

async function slidePrompt(options: SceneContentOptions, outline = slideOutline()) {
  let captured = { system: '', user: '' };
  const aiCall: AICallFn = async (system, user) => {
    captured = { system, user };
    return outline.type === 'quiz' ? '[]' : SLIDE_REPLY;
  };
  await generateSceneContent(outline, aiCall, options);
  return captured;
}

describe('slide content prompt — reading direction', () => {
  it("renders 'ltr' and an absent direction byte-identically", async () => {
    const absent = await slidePrompt({ languageDirective: 'Teach in English.' });
    const ltr = await slidePrompt({ languageDirective: 'Teach in English.', textDirection: 'ltr' });
    expect(ltr).toEqual(absent);
    expect(absent.system).not.toContain('Reading Direction');
    expect(absent.system).not.toContain('{{');
  });

  it("adds the right-to-left layout contract for 'rtl'", async () => {
    const rtl = await slidePrompt({ languageDirective: 'درّس بالعربية.', textDirection: 'rtl' });
    expect(rtl.system).toContain('## Reading Direction — RIGHT-TO-LEFT (MANDATORY)');
    // Mirrors what is read as language…
    expect(rtl.system).toContain('`text-align: right`');
    expect(rtl.system).toContain('run right → left');
    // RSS W4: a default for side-by-side compositions, not a mandate (FR-083),
    // with text-free images and native labels next to them.
    expect(rtl.system).toContain('the default is text on the right and the visual on the left');
    expect(rtl.system).toContain('not a mandate');
    expect(rtl.system).toContain('never mirror or flip the image itself');
    // …and protects what carries meaning.
    expect(rtl.system).toContain('Do NOT mirror content whose direction carries meaning');
    expect(rtl.system).toContain('Charts keep their normal axes');
    expect(rtl.system).toContain('never flipped');
    expect(rtl.system).not.toContain('{{');
  });

  it('is driven by the option, not by the text in the outline or the directive', async () => {
    // An Arabic outline + Arabic directive WITHOUT the metadata: no RTL block.
    const arabicOutline = {
      ...slideOutline(),
      title: 'التمثيل الضوئي',
      description: 'كيف يصنع النبات غذاءه',
      keyPoints: ['الضوء', 'الماء'],
    };
    const sniffed = await slidePrompt({ languageDirective: 'درّس بالعربية.' }, arabicOutline);
    expect(sniffed.system).not.toContain('Reading Direction');

    // An English outline WITH rtl metadata: the block is there.
    const declared = await slidePrompt({
      languageDirective: 'Teach in English.',
      textDirection: 'rtl',
    });
    expect(declared.system).toContain('Reading Direction');
  });

  it('applies to every slide alike — semantics do not change it', async () => {
    const base = await slidePrompt({ textDirection: 'rtl' });
    for (const semantics of [
      { slideType: 'cover', contentRole: 'orientation' },
      { slideType: 'content', contentRole: 'explanation', contentKind: 'concept' },
      { slideType: 'end', contentRole: 'summary' },
    ] as const) {
      const prompt = await slidePrompt(
        { textDirection: 'rtl' },
        { ...slideOutline(), ...semantics },
      );
      expect(prompt.system).toBe(base.system);
    }
  });

  it('leaves non-slide scene prompts untouched', async () => {
    const plain = await slidePrompt({ languageDirective: 'x' }, quizOutline());
    const rtl = await slidePrompt({ languageDirective: 'x', textDirection: 'rtl' }, quizOutline());
    expect(rtl).toEqual(plain);
  });
});

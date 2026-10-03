import { describe, expect, it, vi } from 'vitest';

import type { AICallFn, SceneContentFailure } from '@openmaic/generation';
import { generateSceneContent } from '@openmaic/generation';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

describe('scene content model-output failures', () => {
  it.each([
    ['slide', slideOutline, JSON.stringify({ background: { type: 'solid', color: '#fff' } })],
    ['quiz', quizOutline, JSON.stringify({ question: 'not an array' })],
    ['interactive', widgetOutline, 'INTERACTIVE_RAW_SENTINEL'],
  ] as const)(
    'reports invalid-model-output before returning null for malformed %s content',
    async (_type, makeOutline, response) => {
      const aiCall: AICallFn = vi.fn(async () => response);
      const failures: SceneContentFailure[] = [];

      const content = await generateSceneContent(makeOutline(), aiCall, {
        onFailure: (failure) => failures.push(failure),
      });

      expect(content).toBeNull();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: 'invalid-model-output' });
      if (_type === 'slide') {
        expect(failures[0]?.detail).toBe(
          'the model response was not valid slide JSON with an elements array',
        );
      }
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );

  it('logs the start of an unusable slide answer for diagnosis', async () => {
    const error = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error };
    const response = JSON.stringify({ slide: { elements: [] } });

    await generateSceneContent(
      slideOutline(),
      vi.fn(async () => response),
      { logger },
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining('parsed keys: slide'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('response starts:'));
  });

  it('appends a correctiveNote to the slide prompt only when one is given', async () => {
    const prompts: string[] = [];
    const aiCall: AICallFn = vi.fn(async (_system, user) => {
      prompts.push(user);
      return JSON.stringify({ elements: [] });
    });

    await generateSceneContent(slideOutline(), aiCall, {});
    await generateSceneContent(slideOutline(), aiCall, { correctiveNote: 'FIX THE JSON' });

    expect(prompts[0]).not.toContain('Correction Required');
    expect(prompts[1]).toContain('## Correction Required');
    expect(prompts[1]).toContain('FIX THE JSON');
    expect(prompts[1]!.startsWith(prompts[0]!)).toBe(true);
  });

  it('does not classify capability gates, PBL failures, or provider exceptions', async () => {
    const gateFailures: SceneContentFailure[] = [];
    const gateAiCall: AICallFn = vi.fn();
    const proceduralOutline = {
      ...widgetOutline(),
      widgetType: 'procedural-skill' as const,
      widgetOutline: { concept: 'Calibrate a device' },
    };

    await expect(
      generateSceneContent(proceduralOutline, gateAiCall, {
        onFailure: (failure) => gateFailures.push(failure),
      }),
    ).resolves.toBeNull();
    expect(gateFailures).toEqual([]);
    expect(gateAiCall).not.toHaveBeenCalled();

    const pblFailures: SceneContentFailure[] = [];
    await expect(
      generateSceneContent(
        pblOutline(),
        async () => {
          throw new Error('PBL_PROVIDER_SENTINEL');
        },
        { onFailure: (failure) => pblFailures.push(failure) },
      ),
    ).rejects.toMatchObject({ name: 'PBLGenerationError' });
    expect(pblFailures).toEqual([]);

    const providerFailures: SceneContentFailure[] = [];
    await expect(
      generateSceneContent(
        slideOutline(),
        async () => {
          throw new Error('SLIDE_PROVIDER_SENTINEL');
        },
        { onFailure: (failure) => providerFailures.push(failure) },
      ),
    ).rejects.toThrow('SLIDE_PROVIDER_SENTINEL');
    expect(providerFailures).toEqual([]);
  });
});

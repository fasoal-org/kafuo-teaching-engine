import { describe, expect, it, vi } from 'vitest';

import type { AICallFn } from '@openmaic/generation';
import { generateSceneContent } from '@openmaic/generation';
import { quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

vi.mock('../src/prompts/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/prompts/index.js')>()),
  buildPrompt: vi.fn(() => null),
}));

describe('scene content prompt failures', () => {
  it.each([
    ['slide', slideOutline],
    ['quiz', quizOutline],
    ['interactive', widgetOutline],
  ] as const)(
    'reports prompt-unavailable before returning null for a %s prompt',
    async (_type, makeOutline) => {
      const aiCall: AICallFn = vi.fn();
      const failures: unknown[] = [];

      const content = await generateSceneContent(makeOutline(), aiCall, {
        onFailure: (failure: unknown) => failures.push(failure),
      } as never);

      expect(content).toBeNull();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: 'prompt-unavailable' });
      if (_type === 'slide') {
        expect(failures[0]).toMatchObject({ detail: 'slide content prompt is unavailable' });
      }
      expect(aiCall).not.toHaveBeenCalled();
    },
  );
});

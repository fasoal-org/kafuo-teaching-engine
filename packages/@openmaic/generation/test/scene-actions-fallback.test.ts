import { describe, expect, it, vi } from 'vitest';

import type { AICallFn, SceneActionsFallback } from '@openmaic/generation';
import { generateSceneActions } from '@openmaic/generation';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

/**
 * Module 3/4 W2 (TAE-RQ-017, plan §7.2): every one of the eight
 * default-return sites in `generateSceneActions` reports through `onFallback`
 * with its reason, while the return contract is unchanged — the defaults are
 * still returned, and a caller that passes no observer sees exactly today's
 * behavior.
 */
vi.mock('../src/prompts/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/prompts/index.js')>()),
  buildPrompt: vi.fn(),
}));

import { buildPrompt } from '../src/prompts/index.js';

const INTERACTIVE_HTML = '<!DOCTYPE html><html><head></head><body></body></html>';
const PBL_CONTENT = { projectV2: undefined } as never;
const GARBAGE = 'not a json array at all';

const CASES = [
  {
    type: 'slide',
    outline: slideOutline,
    content: { elements: [], background: { type: 'solid' as const, color: '#fff' } },
    // The slide default: spotlight + speech, independent of the model.
    defaultShape: expect.arrayContaining([expect.objectContaining({ type: 'speech' })]),
  },
  {
    type: 'quiz',
    outline: quizOutline,
    content: { questions: [] },
    defaultShape: [expect.objectContaining({ type: 'speech', title: '测验引导' })],
  },
  {
    type: 'interactive',
    outline: widgetOutline,
    content: { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    defaultShape: [expect.objectContaining({ type: 'speech' })],
  },
  {
    type: 'pbl',
    outline: pblOutline,
    content: PBL_CONTENT,
    defaultShape: [expect.objectContaining({ type: 'speech', title: 'PBL 项目介绍' })],
  },
] as const;

/** A parseable, canonical reply for each scene type (the parser's wire shape). */
function validReply(type: string): string {
  if (type === 'interactive') {
    return JSON.stringify([{ type: 'action', name: 'widget_highlight', params: { target: '#x' } }]);
  }
  return JSON.stringify([{ type: 'text', content: 'A canonical action.' }]);
}

describe('generateSceneActions onFallback — the eight default-return sites', () => {
  describe.each(CASES)('$type', ({ type, outline, content, defaultShape }) => {
    it('reports prompt-unavailable when the prompt cannot be assembled', async () => {
      vi.mocked(buildPrompt).mockReturnValue(null);
      const fallbacks: SceneActionsFallback[] = [];
      const aiCall: AICallFn = vi.fn();

      const actions = await generateSceneActions(outline(), content as never, aiCall, {
        onFallback: (info) => fallbacks.push(info),
      });

      expect(fallbacks).toEqual([{ code: 'prompt-unavailable' }]);
      expect(actions).toEqual(defaultShape);
      expect(aiCall).not.toHaveBeenCalled();
    });

    it('reports invalid-model-output when parsing yields zero actions', async () => {
      vi.mocked(buildPrompt).mockReturnValue({ system: 's', user: 'u' });
      const fallbacks: SceneActionsFallback[] = [];
      const aiCall: AICallFn = vi.fn(async () => GARBAGE);

      const actions = await generateSceneActions(outline(), content as never, aiCall, {
        onFallback: (info) => fallbacks.push(info),
      });

      expect(fallbacks).toEqual([{ code: 'invalid-model-output' }]);
      expect(actions).toEqual(defaultShape);
    });

    it('does not report on a successful parse', async () => {
      vi.mocked(buildPrompt).mockReturnValue({ system: 's', user: 'u' });
      const fallbacks: SceneActionsFallback[] = [];
      const aiCall: AICallFn = vi.fn(async () => validReply(type));

      const actions = await generateSceneActions(outline(), content as never, aiCall, {
        onFallback: (info) => fallbacks.push(info),
      });

      expect(fallbacks).toEqual([]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[0]!.type).not.toBeUndefined();
    });

    it('returns the default array to an observer-less caller exactly as today', async () => {
      vi.mocked(buildPrompt).mockReturnValue({ system: 's', user: 'u' });
      const aiCall: AICallFn = vi.fn(async () => GARBAGE);

      const actions = await generateSceneActions(outline(), content as never, aiCall);

      expect(actions).toEqual(defaultShape);
      expect(aiCall).toHaveBeenCalledOnce();
    });
  });
});

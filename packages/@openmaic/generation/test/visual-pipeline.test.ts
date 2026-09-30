/**
 * RSS Wave 4 (generation half): authorized media sources (T-08) and the
 * enforced planned visual (RSS 7.5.7).
 */
import { describe, expect, it } from 'vitest';
import {
  generateSceneContent,
  plannedVisualIssue,
  requiredSourceVisualIssue,
  type GeneratedSlideContent,
  type SceneOutline,
} from '@openmaic/generation';

const text = (content: string) => ({
  type: 'text',
  left: 60,
  top: 60,
  width: 880,
  height: 76,
  content: `<p>${content}</p>`,
});
const image = (src: string) => ({
  type: 'image',
  left: 60,
  top: 160,
  width: 400,
  height: 225,
  src,
});
const shape = (left: number) => ({
  type: 'shape',
  left,
  top: 300,
  width: 120,
  height: 80,
  path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
  viewBox: [1, 1],
  fill: '#5b9bd5',
  fixedRatio: false,
});

const outline: SceneOutline = {
  id: 'scene_1',
  type: 'slide',
  title: 'Average Speed',
  description: 'Open the lesson.',
  keyPoints: ['Hook', 'Objectives', 'Big idea'],
  order: 1,
  slideType: 'content',
  contentRole: 'example',
};

describe('authorized media sources (T-08)', () => {
  it('removes a model-invented address, keeps mapped ids and registered baseline sources', async () => {
    const reply = JSON.stringify({
      elements: [
        text('Average speed'),
        image('https://evil.example/moe-logo.png'),
        image('/invented/path.png'),
        image('img_1'),
        image('/api/classroom-media/stage-1/media/existing.png'),
      ],
    });
    const content = (await generateSceneContent(outline, async () => reply, {
      assignedImages: [{ id: 'img_1', src: '', pageNumber: 1 }],
      imageMapping: { img_1: 'asset-abc' },
      // Edit mode: a source already on the slide stays authorized.
      baselineContent: {
        elements: [image('/api/classroom-media/stage-1/media/existing.png')] as never,
      },
    })) as GeneratedSlideContent;
    const sources = content.elements
      .filter((element) => element.type === 'image')
      .map((element) => (element as { src: string }).src);
    expect(sources).toEqual(['asset-abc', '/api/classroom-media/stage-1/media/existing.png']);
  });
});

describe('the planned visual is enforced, not logged (RSS 7.5.7)', () => {
  const opening: SceneOutline = {
    ...outline,
    slideType: 'cover',
    contentRole: 'orientation',
    visualPlan: { mode: 'native' },
  };
  const bare = JSON.stringify({ elements: [text('Average Speed')] });
  const native = JSON.stringify({
    elements: [text('Average Speed'), shape(100), shape(300), shape(500)],
  });

  it('judges presence structurally', () => {
    expect(plannedVisualIssue(undefined, [])).toBeUndefined();
    expect(plannedVisualIssue({ mode: 'omitted', omissionReason: 'x' }, [])).toBeUndefined();
    expect(plannedVisualIssue({ mode: 'image' }, [])).toMatch(/planned image is absent/);
    expect(
      requiredSourceVisualIssue(
        [{ id: 'book-1', src: '', pageNumber: 3 }],
        { 'book-1': '/book-1.png' },
        [image('/book-1.png') as never],
      ),
    ).toBeUndefined();
  });

  it('fails once when the exact selected textbook visual is not placed', async () => {
    let calls = 0;
    await expect(
      generateSceneContent(
        { ...opening, visualPlan: { mode: 'image' } },
        async () => {
          calls += 1;
          return native;
        },
        {
          assignedImages: [{ id: 'book-1', src: '', pageNumber: 3 }],
          imageMapping: { 'book-1': '/book-1.png' },
        },
      ),
    ).rejects.toThrow(/selected textbook visual is absent/);
    expect(calls).toBe(1);
  });

  it('regenerates a bare opening once with the native-elements directive', async () => {
    const prompts: string[] = [];
    let call = 0;
    const content = (await generateSceneContent(opening, async (_system, user) => {
      prompts.push(user);
      call += 1;
      return call === 1 ? bare : native;
    })) as GeneratedSlideContent;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('composed from native slide elements');
    expect(content.elements.filter((element) => element.type === 'shape')).toHaveLength(3);
  });

  it('fails with ORIENTATION_VISUAL_MISSING rather than shipping a bare opening', async () => {
    await expect(generateSceneContent(opening, async () => bare)).rejects.toMatchObject({
      code: 'ORIENTATION_VISUAL_MISSING',
    });
  });
});

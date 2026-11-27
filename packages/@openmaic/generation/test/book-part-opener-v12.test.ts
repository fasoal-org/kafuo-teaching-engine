/**
 * g5.v12 (Wave 2, W2.5): the scene writer's opening slide of a book-part lesson lists no
 * learning objectives and states no big idea — on the canvas and in its narration. Only
 * with `bookPartOpener`; every other caller's guidance and prompts are byte-identical.
 */
import { describe, expect, it } from 'vitest';

import type { AICallFn, SceneOutline } from '../src/index.js';
import { generateSceneActions, generateSceneContent } from '../src/index.js';
import {
  BOOK_PART_ORIENTATION_GUIDANCE,
  buildSlideNarrationRoleContext,
  buildSlideRoleContext,
} from '../src/slide-role-guidance.js';

const OPENER = { slideType: 'cover', contentRole: 'orientation' } as never;
const OBJECTIVES = 'concise learning objectives';
const BIG_IDEA = "the lesson's big idea";

const opener = (): SceneOutline =>
  ({
    id: 'open',
    type: 'slide',
    slideType: 'cover',
    contentRole: 'orientation',
    visualPlan: { mode: 'omitted' },
    title: 'Opening',
    description: 'Open the lesson.',
    keyPoints: ['A framing question', 'Why it matters'],
    order: 1,
  }) as SceneOutline;

function capture(response: string): { call: AICallFn; prompts: string[] } {
  const prompts: string[] = [];
  const call: AICallFn = async (system, user) => {
    prompts.push(`${system}\n${user}`);
    return response;
  };
  return { call, prompts };
}

const CONTENT = JSON.stringify({
  elements: [{ type: 'text', content: 'Opening', left: 100, top: 100, width: 600, height: 60 }],
});
const ACTIONS = JSON.stringify([{ type: 'text', content: 'Welcome.' }]);

describe('g5.v12 opener guidance (W2.5)', () => {
  it('the canvas guidance drops the objectives and the big idea with bookPartOpener only', () => {
    const plain = buildSlideRoleContext(OPENER).roleGuidance;
    const v12 = buildSlideRoleContext(OPENER, { bookPartOpener: true }).roleGuidance;
    expect(plain).toContain(OBJECTIVES);
    expect(plain).toContain(BIG_IDEA);
    expect(v12).not.toContain(OBJECTIVES);
    expect(v12).not.toContain(BIG_IDEA);
    expect(v12).toContain(BOOK_PART_ORIENTATION_GUIDANCE);
    expect(v12).toContain('this opening carries neither');
    // Another role is unchanged by the flag.
    const explain = { contentRole: 'explanation' } as never;
    expect(buildSlideRoleContext(explain, { bookPartOpener: true })).toEqual(
      buildSlideRoleContext(explain),
    );
  });

  it('the narration frames the hook and the context only with bookPartOpener', () => {
    const plain = buildSlideNarrationRoleContext(OPENER).roleGuidance;
    const v12 = buildSlideNarrationRoleContext(OPENER, { bookPartOpener: true }).roleGuidance;
    expect(plain).toContain('the objectives and the big idea');
    expect(v12).not.toContain('the objectives and the big idea');
    expect(v12).toContain('Never list learning objectives or announce a big idea.');
  });

  it('reaches the slide-content and slide-actions prompts; absent, they are byte-identical', async () => {
    const plainContent = capture(CONTENT);
    const v12Content = capture(CONTENT);
    const slide = await generateSceneContent(opener(), plainContent.call, {});
    await generateSceneContent(opener(), v12Content.call, { bookPartOpener: true });
    const plainText = plainContent.prompts.join('\n');
    const v12Text = v12Content.prompts.join('\n');
    expect(plainText).toContain(OBJECTIVES);
    expect(v12Text).not.toContain(OBJECTIVES);
    expect(v12Text).toContain('this opening carries neither');

    const plainActions = capture(ACTIONS);
    const v12Actions = capture(ACTIONS);
    const content = (slide ?? { elements: [] }) as never;
    await generateSceneActions(opener(), content, plainActions.call, {});
    await generateSceneActions(opener(), content, v12Actions.call, { bookPartOpener: true });
    expect(plainActions.prompts.join('\n')).toContain('the objectives and the big idea');
    expect(v12Actions.prompts.join('\n')).toContain(
      'Never list learning objectives or announce a big idea.',
    );

    // Off v12 the flag is simply absent: the same prompts as a call without it.
    const again = capture(CONTENT);
    await generateSceneContent(opener(), again.call, {});
    expect(again.prompts).toEqual(plainContent.prompts);
  });
});

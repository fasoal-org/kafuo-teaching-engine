/**
 * g5.v12 (Wave 2, W2.5): the scene writer's opening slide of a book-part lesson follows
 * the backend's g5.v12 opener (`G5_V12_OPENER_INSTRUCTIONS`): the lesson title, one
 * sentence on what the lesson teaches today and at most one recall; no hook, no
 * objectives list, no invented big idea — on the canvas and in its narration. Only with
 * `bookPartOpener`; every other caller's guidance and prompts are byte-identical.
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
const HOOK = 'a hook or framing question';
const TODAY = 'one sentence saying what the lesson teaches today';
const NARRATION = "At most three short sentences: the lesson's title, what it teaches today";

const opener = (visualPlan: { mode: string } = { mode: 'omitted' }): SceneOutline =>
  ({
    id: 'open',
    type: 'slide',
    slideType: 'cover',
    contentRole: 'orientation',
    visualPlan,
    title: 'Opening',
    description: 'Open the lesson.',
    keyPoints: ['Lesson title', 'What this lesson teaches today'],
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

describe('g5.v12 opener guidance (W2.5, aligned with the backend opener)', () => {
  it('the canvas guidance is the backend opener with bookPartOpener only', () => {
    const plain = buildSlideRoleContext(OPENER).roleGuidance;
    const v12 = buildSlideRoleContext(OPENER, { bookPartOpener: true }).roleGuidance;
    for (const line of [OBJECTIVES, BIG_IDEA, HOOK]) {
      expect(plain).toContain(line);
      expect(v12).not.toContain(line);
    }
    expect(v12).toContain(BOOK_PART_ORIENTATION_GUIDANCE);
    expect(v12).toContain(TODAY);
    expect(v12).toContain('«الفكرة الرئيسة»');
    expect(v12).toContain('a one-line recall of it');
    expect(v12).toContain("the book's hook question (the lesson answers it later)");
    expect(v12).toContain("a 'big idea' the book does not print");
    expect(BOOK_PART_ORIENTATION_GUIDANCE).not.toMatch(/\bhook\b(?! question)/);
    // Another role is unchanged by the flag.
    const explain = { contentRole: 'explanation' } as never;
    expect(buildSlideRoleContext(explain, { bookPartOpener: true })).toEqual(
      buildSlideRoleContext(explain),
    );
  });

  it('the narration is at most three short sentences and never opens with the hook', () => {
    const plain = buildSlideNarrationRoleContext(OPENER).roleGuidance;
    const v12 = buildSlideNarrationRoleContext(OPENER, { bookPartOpener: true }).roleGuidance;
    expect(plain).toContain('Open with the hook');
    expect(v12).not.toContain('Open with the hook');
    expect(v12).not.toContain('direction and curiosity');
    expect(v12).toContain(NARRATION);
    expect(v12).toContain("Never tell an opening story or ask the book's hook question");
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
    expect(v12Text).toContain(TODAY);

    const plainActions = capture(ACTIONS);
    const v12Actions = capture(ACTIONS);
    const content = (slide ?? { elements: [] }) as never;
    await generateSceneActions(opener(), content, plainActions.call, {});
    await generateSceneActions(opener(), content, v12Actions.call, { bookPartOpener: true });
    expect(plainActions.prompts.join('\n')).toContain('Open with the hook');
    expect(v12Actions.prompts.join('\n')).toContain(NARRATION);

    // Off v12 the flag is simply absent: the same prompts as a call without it.
    const again = capture(CONTENT);
    await generateSceneContent(opener(), again.call, {});
    expect(again.prompts).toEqual(plainContent.prompts);
  });

  it('re-review NIT-c: on page 1 of a v12 run the narration is the short opener, never a course introduction', async () => {
    const ctx = {
      pageIndex: 1,
      totalPages: 3,
      allTitles: ['Opening', 'A', 'B'],
      previousSpeeches: [],
    };
    const plain = capture(ACTIONS);
    const v12 = capture(ACTIONS);
    await generateSceneActions(opener(), { elements: [] } as never, plain.call, { ctx });
    await generateSceneActions(opener(), { elements: [] } as never, v12.call, {
      ctx,
      bookPartOpener: true,
    });
    const plainText = plain.prompts.join('\n');
    const v12Text = v12.prompts.join('\n');
    const intro = 'Position: This is the FIRST page. Open with a greeting and course introduction.';
    const rule =
      'On this lesson the first page is its short opening slide instead: at most three short sentences and no course introduction.';
    expect(plainText).toContain(intro);
    expect(plainText).not.toContain(rule);
    expect(v12Text).not.toContain(intro);
    expect(v12Text).toContain(rule);
    expect(v12Text).toContain(
      "Position: This is the FIRST page, the lesson's short opening: at most three short sentences, no course introduction.",
    );
  });

  it('a native visual plan that misses its visual: the native regeneration keeps the v12 opener', async () => {
    const v12 = capture(CONTENT);
    const issues: unknown[] = [];
    await generateSceneContent(opener({ mode: 'native' }), v12.call, {
      bookPartOpener: true,
      onVisualIssue: (issue) => void issues.push(issue),
    });
    // The first canvas has no native visual, so the slide is generated once more.
    expect(v12.prompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of v12.prompts) {
      expect(prompt).toContain(TODAY);
      expect(prompt).not.toContain(OBJECTIVES);
    }
    const plain = capture(CONTENT);
    await generateSceneContent(opener({ mode: 'native' }), plain.call, {
      onVisualIssue: () => undefined,
    });
    expect(plain.prompts.length).toBe(v12.prompts.length);
    for (const prompt of plain.prompts) expect(prompt).toContain(OBJECTIVES);
  });
});

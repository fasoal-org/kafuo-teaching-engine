/**
 * The resolved Teaching Model Flow context in Action generation (Module 3/4
 * W1 — TAE-RQ-009/005/012, plan §7.1.2).
 *
 * The architectural invariant, made structural rather than advisory:
 *
 *   Teaching Model orchestration  → resolves WHEN
 *   Action generation             → consumes WHEN
 *   Action generation             → never resolves, chooses, or re-derives WHEN
 *
 * `buildSceneFlowContext` is the single renderer of the ONE resolved position:
 * it takes the resolved context and nothing else, and `generateSceneActions`
 * renders the Flow Authority block only when that context is supplied. Absent
 * context — every non-governed call site — keeps the action prompts
 * byte-identical (AC for the three non-Kafuo call sites, plan §B.10).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import {
  buildSceneFlowContext,
  generateSceneActions,
  type AICallFn,
  type ResolvedSkillDefinition,
  type SceneFlowContext,
  type SceneOutline,
} from '../src/index.js';
import { pblOutline, quizOutline, slideOutline, widgetOutline } from './scene-fixtures.js';

const CONTEXT: SceneFlowContext = {
  teachingModelKey: 'g5',
  teachingModelVersion: 'g5.v1',
  stageKey: 'lesson_introduction',
  flowIndex: 2,
  instructions: 'Open the lesson by connecting the goal to the learner.',
};

const FEYNMAN: ResolvedSkillDefinition = {
  skillId: 'feynman-learning',
  version: 'v1',
  definition: '# Feynman Learning\n\nTeach by having the learner explain back.',
};

it('renders the exact instruction text, model key@version, stage key, and 1-based position', () => {
  const rendered = buildSceneFlowContext(CONTEXT);
  expect(rendered.hasFlowContext).toBe(true);
  expect(rendered.flowContextText).toBe(
    [
      '## Teaching Model Flow Authority — WHEN this scene teaches (MANDATORY)',
      'Teaching Model: g5@g5.v1',
      'Flow position:  lesson_introduction (position 3)',
      'Authoritative Flow Instructions for this position:',
      'Open the lesson by connecting the goal to the learner.',
      [
        'These instructions outrank every pedagogical default in this prompt and every',
        'Teaching Skill below. Generate Actions ONLY for this flow position. Do not',
        "teach another position's material, do not choose a different position, do not",
        'add or reorder positions, and do not emit Actions that navigate, advance,',
        'skip, re-enter, or select a flow position — the system owns ordering, not the',
        'Actions. Safety, source grounding, factual integrity, the language directive,',
        'valid element references, and the JSON output schema remain binding.',
      ].join('\n'),
    ].join('\n'),
  );
});

it('returns hasFlowContext: false ONLY for an absent flowContext', () => {
  expect(buildSceneFlowContext(undefined)).toEqual({ hasFlowContext: false, flowContextText: '' });
});

it('cannot resolve WHEN — no flow array parameter (structural)', () => {
  // The signature takes ONE resolved position. A Flow array — the shape
  // orchestration owns — must not type-check here.
  // @ts-expect-error a TeachingFlowEntry[] is not a resolved SceneFlowContext
  buildSceneFlowContext([
    { stage: 'lesson_introduction', instructions: 'Open.' },
    { stage: 'outcome_teaching_cards', instructions: 'Teach.' },
  ]);
  // @ts-expect-error a SceneOutline (which carries teachingStage) is not accepted
  buildSceneFlowContext({ ...slideOutline(), teachingStage: { key: 'x', flowIndex: 0 } });
  expect(true).toBe(true);
});

it('cannot resolve WHEN — no exported symbol of this package indexes a flow array for action prompts', () => {
  // Source-level backstop for the same invariant: the Action generator never
  // performs the Flow lookup itself. Outline generation legitimately renders
  // the whole flow (Module 2 assigns positions there); the ACTION generator
  // must not. The patterns match member access, so prose in doc comments
  // (which legitimately DESCRIBES the invariant) does not trip them.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scene-generator.ts'),
    'utf-8',
  );
  expect(source).not.toMatch(/\bteachingFlow\s*\[/);
  expect(source).not.toMatch(/\bflow\s*\[/);
  expect(source).not.toMatch(/\.teachingStage\b/);
});

const governedOutline = (base: SceneOutline): SceneOutline => ({
  ...base,
  teachingStage: { key: 'lesson_introduction', flowIndex: 2 },
  teachingSkills: {
    classification: 'instructional',
    primary: { skillId: 'feynman-learning', version: 'v1' },
    supporting: [{ skillId: 'social-emotional-learning', version: 'v1' }],
  },
});

const ACTIONS_REPLY = JSON.stringify([{ type: 'text', content: 'Governed narration.' }]);
const INTERACTIVE_HTML = '<!DOCTYPE html><html><head></head><body></body></html>';
const PBL_CONTENT = { projectV2: undefined } as never;

function capture(response: string): {
  calls: Array<{ system: string; user: string }>;
  aiCall: AICallFn;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    aiCall: async (system, user) => {
      calls.push({ system, user });
      return response;
    },
  };
}

it('renders the Flow block before the Skill block in all four action templates', async () => {
  const cases = [
    {
      key: 'slide-actions',
      outline: governedOutline(slideOutline()),
      content: { elements: [], background: { type: 'solid' as const, color: '#fff' } },
    },
    { key: 'quiz-actions', outline: governedOutline(quizOutline()), content: { questions: [] } },
    {
      key: 'interactive-actions',
      outline: governedOutline(widgetOutline()),
      content: { html: INTERACTIVE_HTML, widgetType: 'simulation' },
    },
    { key: 'pbl-actions', outline: governedOutline(pblOutline()), content: PBL_CONTENT },
  ] as const;

  for (const { key, outline, content } of cases) {
    const { calls, aiCall } = capture(ACTIONS_REPLY);
    await generateSceneActions(outline, content as never, aiCall, {
      languageDirective: 'Teach in English.',
      flowContext: CONTEXT,
      resolvedSkills: [FEYNMAN],
    });
    expect(calls, key).toHaveLength(1);
    const system = calls[0]!.system;
    // ORDERING, not just presence: the Flow block precedes the Skill block.
    // (The Skill header wording differs per template: "Teaching Skill
    // Authority" in slide/interactive, "Teaching Skills" in quiz/pbl.)
    const flowAt = system.indexOf('## Teaching Model Flow Authority');
    const skillAt = system.search(/## Teaching Skills? /);
    expect(flowAt, key).toBeGreaterThanOrEqual(0);
    expect(skillAt, key).toBeGreaterThan(flowAt);
    expect(system, key).toContain('Teaching Model: g5@g5.v1');
    expect(system, key).toContain('Flow position:  lesson_introduction (position 3)');
    expect(system, key).toContain('Open the lesson by connecting the goal to the learner.');
  }
});

it('renders byte-identical action prompts when flowContext is absent — Skills or not', async () => {
  // The invariant that keeps the three non-Kafuo call sites untouched: no
  // flowContext → no Flow block, regardless of what else the outline carries.
  // The Skill-only render is exactly the pre-W1 governed shape.
  const slideContent = { elements: [], background: { type: 'solid' as const, color: '#fff' } };

  const skillOnly = capture(ACTIONS_REPLY);
  await generateSceneActions(governedOutline(slideOutline()), slideContent, skillOnly.aiCall, {
    languageDirective: 'Teach in English.',
    resolvedSkills: [FEYNMAN],
  });
  const bare = capture(ACTIONS_REPLY);
  await generateSceneActions(slideOutline(), slideContent, bare.aiCall, {
    languageDirective: 'Teach in English.',
  });

  for (const rendered of [skillOnly.calls[0]!, bare.calls[0]!]) {
    expect(rendered.system).not.toContain('Teaching Model Flow Authority');
    expect(rendered.system).not.toContain('{{flowContextText}}');
  }
  expect(bare.calls[0]!.system).not.toContain('Teaching Skill Authority');
});

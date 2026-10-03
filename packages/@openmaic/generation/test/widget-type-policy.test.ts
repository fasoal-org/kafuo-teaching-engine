// A caller-prohibited widget type (Kafuo Release 1 defers `game`) is told to the
// planner, reported on the outline, and refused before any widget model call —
// and with no prohibition every prompt and analysis is unchanged.
import { describe, expect, test, vi } from 'vitest';
import {
  WIDGET_TYPE_PROHIBITED,
  WidgetTypeProhibitedError,
  analyzeOutlines,
  blockingOutlineDiagnostics,
  buildOutlinePrompt,
  generateSceneContent,
  generateSceneOutlinesFromRequirements,
  interactiveWidgetTypeOf,
  prohibitedWidgetDiagnostics,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

const slide: SceneOutline = {
  id: 'o-slide',
  type: 'slide',
  slideType: 'content',
  contentRole: 'summary',
  title: 'Summary',
  description: 'Recap',
  keyPoints: ['one'],
  order: 1,
};

const game: SceneOutline = {
  id: 'o-game',
  type: 'interactive',
  title: 'Fraction race',
  description: 'Practise fractions',
  keyPoints: ['fractions'],
  order: 2,
  widgetType: 'game',
  widgetOutline: { concept: 'fractions', gameType: 'quiz' },
};

/** A legacy interactive outline whose free text infers a game widget. */
const inferredGame: SceneOutline = {
  id: 'o-legacy',
  type: 'interactive',
  title: 'Practice puzzle',
  description: 'A puzzle',
  keyPoints: ['puzzle'],
  order: 3,
  interactiveConfig: {
    conceptName: 'matching puzzle',
    conceptOverview: 'match pairs',
    designIdea: 'a practice game with a challenge',
  },
};

const simulation: SceneOutline = {
  ...game,
  id: 'o-sim',
  title: 'Force explorer',
  widgetType: 'simulation',
  widgetOutline: { concept: 'force' },
};

describe('interactiveWidgetTypeOf', () => {
  test('reads the widget the scene generator would build', () => {
    expect(interactiveWidgetTypeOf(slide)).toBeUndefined();
    expect(interactiveWidgetTypeOf(game)).toBe('game');
    expect(interactiveWidgetTypeOf(inferredGame)).toBe('game');
    expect(interactiveWidgetTypeOf(simulation)).toBe('simulation');
    const { widgetType: _w, widgetOutline: _o, ...bare } = game;
    expect(interactiveWidgetTypeOf(bare)).toBe('simulation');
  });
});

describe('the outline check', () => {
  test('reports every outline that would build a prohibited widget, explicit or inferred', () => {
    const findings = prohibitedWidgetDiagnostics([slide, game, inferredGame, simulation], ['game']);
    expect(findings.map((finding) => [finding.code, finding.outlineId, finding.field])).toEqual([
      [WIDGET_TYPE_PROHIBITED, 'o-game', 'widgetType'],
      [WIDGET_TYPE_PROHIBITED, 'o-legacy', 'type'],
    ]);
    expect(findings.every((finding) => finding.disposition === 'admin_correctable')).toBe(true);
    expect(findings[0]!.message).toContain('never the same experience restated as a quiz');
  });

  test('blocks the analysis only when a caller prohibits the widget', () => {
    const without = analyzeOutlines([slide, game]);
    expect(without.widgets).toEqual([]);
    expect(blockingOutlineDiagnostics(without).some((d) => d.code === WIDGET_TYPE_PROHIBITED)).toBe(
      false,
    );

    const withRule = analyzeOutlines([slide, game], { prohibitedWidgetTypes: ['game'] });
    expect(withRule.widgets.map((finding) => finding.outlineId)).toEqual(['o-game']);
    expect(blockingOutlineDiagnostics(withRule).map((d) => d.code)).toContain(
      WIDGET_TYPE_PROHIBITED,
    );
    // The outline itself is never rewritten: no machine changes a scene type.
    expect(withRule.outlines[1]).toMatchObject({ type: 'interactive', widgetType: 'game' });
  });

  test('a planned game fails the answer, or is collected for a person to correct', async () => {
    const aiCall: AICallFn = vi.fn(async () =>
      JSON.stringify({ languageDirective: 'Teach in English.', outlines: [slide, game] }),
    );
    const failed = await generateSceneOutlinesFromRequirements(
      { requirement: 'Fractions' },
      undefined,
      undefined,
      aiCall,
      { prohibitedWidgetTypes: ['game'] },
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/^WIDGET_TYPE_PROHIBITED: /);

    const collected = await generateSceneOutlinesFromRequirements(
      { requirement: 'Fractions' },
      undefined,
      undefined,
      aiCall,
      { prohibitedWidgetTypes: ['game'], collectCorrectableIssues: true },
    );
    expect(collected.success).toBe(true);
    expect(collected.data?.diagnostics.map((d) => d.code)).toContain(WIDGET_TYPE_PROHIBITED);

    const unrestricted = await generateSceneOutlinesFromRequirements(
      { requirement: 'Fractions' },
      undefined,
      undefined,
      aiCall,
    );
    expect(unrestricted.success).toBe(true);
  });
});

describe('the outline prompt', () => {
  test('names the prohibited widget, and is byte-identical without one', () => {
    const base = buildOutlinePrompt({ requirement: 'Fractions' });
    expect(buildOutlinePrompt({ requirement: 'Fractions' }, { prohibitedWidgetTypes: [] })).toEqual(
      base,
    );
    expect(base.system).not.toContain('Widget availability for THIS course');

    const restricted = buildOutlinePrompt(
      { requirement: 'Fractions' },
      { prohibitedWidgetTypes: ['game'] },
    );
    expect(restricted.system).toContain(
      'Widget availability for THIS course: `game` interactive widgets cannot be generated.',
    );
    expect(restricted.system).toContain('never restate that experience as a quiz, a slide');
    expect(restricted.user).toBe(base.user);
  });
});

describe('scene content generation', () => {
  test.each([
    ['an explicit game', game],
    ['a game inferred from a legacy config', inferredGame],
  ])('refuses %s before any model call', async (_label, outline) => {
    const aiCall: AICallFn = vi.fn(async () => '{}');
    await expect(
      generateSceneContent(outline, aiCall, { prohibitedWidgetTypes: ['game'] }),
    ).rejects.toBeInstanceOf(WidgetTypeProhibitedError);
    expect(aiCall).not.toHaveBeenCalled();
  });

  test('builds an allowed widget, and a game when nothing is prohibited', async () => {
    const aiCall: AICallFn = vi.fn(async () => 'not html');
    await generateSceneContent(simulation, aiCall, { prohibitedWidgetTypes: ['game'] });
    await generateSceneContent(game, aiCall, {});
    expect(aiCall).toHaveBeenCalled();
    const calls = (aiCall as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

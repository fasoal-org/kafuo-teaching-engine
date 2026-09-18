import { describe, expect, it } from 'vitest';

import { ACTION_TYPES, type Action } from '@openmaic/dsl';

import { validateSceneActionStructure } from '@/lib/server/teaching-package/action-validation';
import type { AppScene, Stage } from '@/lib/types/stage';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

/**
 * Module 3/4 W3 — the shared canonical Action validator (plan §7.3/§9.2).
 * Structure via the DSL's own primitives; exactly four deterministic
 * reference categories; three exclusions pinned by tests asserting NO
 * finding, so a later reader cannot "fix" them.
 */

const ELEMENT_ID = 'el-text-1';
const VIDEO_ID = 'el-video-1';
const AGENT_ID = 'agent-student-1';

function slideScene(actions: Action[], id = 'scene-1'): AppScene {
  const base = makeSlideScene(id, 'stage-1', 1);
  const baseCanvas = (base.content as { canvas: object }).canvas;
  return {
    ...base,
    content: {
      type: 'slide',
      canvas: {
        ...baseCanvas,
        elements: [
          {
            id: ELEMENT_ID,
            type: 'text',
            content: 'A text element',
            left: 0,
            top: 0,
            width: 100,
            height: 10,
            rotate: 0,
          },
          {
            id: VIDEO_ID,
            type: 'video',
            src: '/api/classroom-media/stage-1/video/lesson.mp4',
            left: 0,
            top: 20,
            width: 100,
            height: 40,
            rotate: 0,
          },
        ],
      },
    },
    actions,
  } as AppScene;
}

const STAGE = {
  generatedAgentConfigs: [{ id: AGENT_ID, name: 'Student', role: 'student' }],
} as unknown as Stage;

const action = (fields: Record<string, unknown>): Action =>
  ({ id: 'action-1', ...fields }) as unknown as Action;

/** One structurally valid Action per canonical type, all references valid. */
const VALID_BY_TYPE: Record<string, Record<string, unknown>> = {
  spotlight: { type: 'spotlight', elementId: ELEMENT_ID },
  laser: { type: 'laser', elementId: ELEMENT_ID },
  play_video: { type: 'play_video', elementId: VIDEO_ID },
  speech: { type: 'speech', text: 'Canonical narration.' },
  wb_open: { type: 'wb_open' },
  wb_draw_text: { type: 'wb_draw_text', content: 'Note', x: 1, y: 1 },
  wb_draw_shape: { type: 'wb_draw_shape', shape: 'rect', x: 1, y: 1, width: 2, height: 2 },
  wb_draw_chart: {
    type: 'wb_draw_chart',
    chartType: 'bar',
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    data: { rows: [] },
  },
  wb_draw_latex: { type: 'wb_draw_latex', latex: 'E=mc^2', x: 1, y: 1 },
  wb_draw_table: { type: 'wb_draw_table', x: 1, y: 1, width: 2, height: 2, data: [] },
  wb_draw_line: { type: 'wb_draw_line', startX: 0, startY: 0, endX: 1, endY: 1 },
  wb_draw_code: { type: 'wb_draw_code', language: 'ts', code: 'void', x: 1, y: 1 },
  wb_edit_code: { type: 'wb_edit_code', elementId: 'wb-el-1', operation: 'append' },
  wb_clear: { type: 'wb_clear' },
  wb_delete: { type: 'wb_delete', elementId: 'wb-el-1' },
  wb_close: { type: 'wb_close' },
  discussion: { type: 'discussion', topic: 'Check understanding', agentId: AGENT_ID },
  widget_highlight: { type: 'widget_highlight', target: '#chart' },
  widget_setState: { type: 'widget_setState', state: { mode: 'idle' } },
  widget_annotation: { type: 'widget_annotation', target: '#chart .bar' },
  widget_reveal: { type: 'widget_reveal', target: '#answer' },
};

describe('validateSceneActionStructure — canonical structure', () => {
  it('produces zero findings for a valid sweep over ALL canonical types', () => {
    expect(ACTION_TYPES).toHaveLength(21);
    const actions = ACTION_TYPES.map((type, index) =>
      action({ ...VALID_BY_TYPE[type]!, id: `action-${index + 1}` }),
    );
    expect(validateSceneActionStructure([slideScene(actions)], { stage: STAGE })).toEqual([]);
  });

  it.each([
    ['empty id', action({ ...VALID_BY_TYPE.speech, id: '' }), 'ACTION_STRUCTURE_INVALID', '/id'],
    [
      'missing id',
      action({ ...VALID_BY_TYPE.speech, id: undefined }),
      'ACTION_STRUCTURE_INVALID',
      '/id',
    ],
    ['unknown type', action({ type: 'teleport_student' }), 'ACTION_TYPE_UNKNOWN', undefined],
    ['speech without text', action({ type: 'speech' }), 'ACTION_STRUCTURE_INVALID', '/text'],
    [
      'spotlight without elementId',
      action({ type: 'spotlight' }),
      'ACTION_STRUCTURE_INVALID',
      '/elementId',
    ],
    [
      'wb_draw_chart with non-object data',
      action({
        type: 'wb_draw_chart',
        chartType: 'bar',
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        data: 'not-an-object',
      }),
      'ACTION_STRUCTURE_INVALID',
      '/data',
    ],
  ])('refuses %s', (_label, invalid, code, path) => {
    const findings = validateSceneActionStructure([slideScene([invalid])], { stage: STAGE });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code, ...(path ? { path } : {}) });
    expect(findings[0]!.sceneId).toBe('scene-1');
    expect(findings[0]!.actionId === undefined || typeof findings[0]!.actionId === 'string').toBe(
      true,
    );
  });

  it('names sceneId, action id, and the unknown type verbatim, demanding explicit replacement', () => {
    const findings = validateSceneActionStructure(
      [slideScene([action({ type: 'legacy_teleport' })])],
      { stage: STAGE },
    );
    expect(findings[0]!.message).toContain('"legacy_teleport"');
    expect(findings[0]!.message).toContain(
      'removed or explicitly replaced with one or more canonical current OpenMAIC Actions',
    );
    // TAE-RQ-032: no candidate replacement is ever inferred.
    expect(findings[0]!.message).not.toMatch(/instead|replacing it with|use .* instead/i);
  });
});

describe('validateSceneActionStructure — the four reference checks', () => {
  it.each([
    [
      'spotlight',
      { type: 'spotlight', elementId: ELEMENT_ID },
      { type: 'spotlight', elementId: 'el-missing' },
    ],
    ['laser', { type: 'laser', elementId: ELEMENT_ID }, { type: 'laser', elementId: 'el-missing' }],
    [
      'play_video',
      { type: 'play_video', elementId: VIDEO_ID },
      { type: 'play_video', elementId: 'el-missing' },
    ],
    [
      'play_video (element exists but is not a video)',
      { type: 'play_video', elementId: VIDEO_ID },
      { type: 'play_video', elementId: ELEMENT_ID },
    ],
    [
      'discussion',
      { type: 'discussion', topic: 'T', agentId: AGENT_ID },
      { type: 'discussion', topic: 'T', agentId: 'agent-missing' },
    ],
  ])('%s: valid passes, invalid is refused', (_label, valid, invalid) => {
    expect(validateSceneActionStructure([slideScene([action(valid)])], { stage: STAGE })).toEqual(
      [],
    );
    const findings = validateSceneActionStructure([slideScene([action(invalid)])], {
      stage: STAGE,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'ACTION_REFERENCE_INVALID' });
  });

  it('play_video resolves across slide Scenes — a video element on ANOTHER scene is valid', () => {
    const other = slideScene([], 'scene-2');
    const findings = validateSceneActionStructure(
      [
        {
          ...slideScene([action({ type: 'play_video', elementId: VIDEO_ID })]),
          content: { type: 'quiz', questions: [] },
        } as unknown as AppScene,
        other,
      ],
      { stage: STAGE },
    );
    // resolveActionVideoMedia semantics: the video element may live on any
    // slide Scene, not only the action's own.
    expect(findings).toEqual([]);
  });

  it('discussion resolves against the default-agent roster (agentIds) too', () => {
    const stage = { agentIds: [AGENT_ID] } as unknown as Stage;
    expect(
      validateSceneActionStructure(
        [slideScene([action({ type: 'discussion', topic: 'T', agentId: AGENT_ID })])],
        { stage },
      ),
    ).toEqual([]);
  });
});

describe('validateSceneActionStructure — the three exclusions produce NO finding', () => {
  it('speech with a dangling audioId is a degradation, not an invalidity', () => {
    const findings = validateSceneActionStructure(
      [
        slideScene([
          action({
            type: 'speech',
            text: 'Narration.',
            audioId: '/api/classroom-media/stage-1/audio/gone.mp3',
          }),
        ]),
      ],
      { stage: STAGE },
    );
    expect(findings).toEqual([]);
  });

  it('wb_delete naming an element no wb_draw_* creates is runtime-only, not validated', () => {
    const findings = validateSceneActionStructure(
      [
        slideScene([
          action({
            type: 'wb_draw_chart',
            chartType: 'bar',
            x: 1,
            y: 1,
            width: 2,
            height: 2,
            data: { a: 1 },
          }),
          action({ type: 'wb_delete', elementId: 'wb-never-created' }),
        ]),
      ],
      { stage: STAGE },
    );
    expect(findings).toEqual([]);
  });

  it('widget_highlight with an arbitrary selector is resolved inside the iframe, not here', () => {
    const findings = validateSceneActionStructure(
      [slideScene([action({ type: 'widget_highlight', target: '#whatever .deep .selector' })])],
      { stage: STAGE },
    );
    expect(findings).toEqual([]);
  });
});

describe('validateSceneActionStructure — diagnostics are identity-only', () => {
  it('serialized findings never carry narration, content, code, latex, topic, or state', () => {
    const sentinelNarration = 'SENTINEL_NARRATION_TEXT';
    const sentinelCode = 'SENTINEL_WB_CODE';
    const sentinelLatex = 'SENTINEL_LATEX';
    const sentinelTopic = 'SENTINEL_TOPIC';
    const sentinelState = 'SENTINEL_WIDGET_STATE';
    const findings = validateSceneActionStructure(
      [
        slideScene([
          action({ type: 'speech', text: sentinelNarration }), // valid → no finding
          action({ ...VALID_BY_TYPE.speech, text: sentinelNarration, id: '' }), // structure
          action({ type: 'teleport', text: sentinelNarration }), // unknown
          action({ type: 'spotlight', elementId: 'el-missing' }), // reference
          action({ ...VALID_BY_TYPE.wb_draw_code, code: sentinelCode, id: 'a-code', language: '' }), // structure via language
          action({
            ...VALID_BY_TYPE.wb_draw_latex,
            latex: sentinelLatex,
            id: '',
            x: 'not-a-number',
          }),
          action({ ...VALID_BY_TYPE.discussion, topic: sentinelTopic, agentId: 'agent-missing' }),
          action({ ...VALID_BY_TYPE.widget_setState, state: { secret: sentinelState }, id: '' }),
        ]),
      ],
      { stage: STAGE },
    );
    expect(findings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(findings);
    for (const sentinel of [
      sentinelNarration,
      sentinelCode,
      sentinelLatex,
      sentinelTopic,
      sentinelState,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});

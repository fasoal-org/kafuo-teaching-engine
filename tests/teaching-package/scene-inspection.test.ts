/**
 * Module 3/4 W5 — the inspection builder's Action projection (plan §7.5,
 * TAE-RQ-025/027).
 *
 * Three invariants, one per describe:
 *
 * 1. ATTRIBUTION — W3's `validateSceneActionStructure` is invoked (never
 *    reimplemented) over the full scene set and its findings attribute to the
 *    right `sceneId`/`actionId` for ALL FOUR Scene types.
 * 2. NO CONTENT LEAK — the serialized inspection payload carries Action
 *    identity and findings only; none of `text`, `content`, `code`, `latex`,
 *    `topic`, `state` values survive into it (TAE-RQ-027). The timeline
 *    already renders Action content — the governance payload must not.
 * 3. NO SECOND VALIDATOR — scene-inspection.ts imports
 *    validateSceneActionStructure and contains no independent
 *    `isActionType`/`validateAction` logic of its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildStageTeachingSkillsInspection } from '@/lib/server/teaching-package/scene-inspection';
import type { AppScene, Stage } from '@/lib/types/stage';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const FIXED_NOW = 1_700_000_000_000;
const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };

const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'i',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN],
      combinationRestrictions: [],
    },
  },
];

const STAGE = {
  generatedAgentConfigs: [{ id: 'agent-roster-1', name: 'Student', role: 'student' }],
} as unknown as Stage;

const slideWith = (id: string, actions: unknown[], elementIds: string[] = []): AppScene =>
  ({
    ...makeSlideScene(id, 'stage-1', 1),
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { primary: FEYNMAN, classification: 'instructional' },
    actions,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#2563eb'],
          fontColor: '#111827',
          fontName: 'Inter',
        },
        elements: elementIds.map((elementId) => ({
          id: elementId,
          type: 'text',
          content: `element ${elementId}`,
          left: 0,
          top: 0,
          width: 100,
          height: 10,
          rotate: 0,
        })),
      },
    },
  }) as AppScene;

const bareScene = (
  id: string,
  type: 'quiz' | 'interactive' | 'pbl',
  actions: unknown[],
): AppScene =>
  ({
    id,
    stageId: 'stage-1',
    title: id,
    order: 2,
    type,
    content:
      type === 'quiz'
        ? { type: 'quiz', questions: [] }
        : type === 'interactive'
          ? { type: 'interactive', url: 'https://example.test/widget' }
          : { type: 'pbl' },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
    teachingSkills: { primary: FEYNMAN, classification: 'instructional' },
    actions,
  }) as unknown as AppScene;

describe('W5 buildStageTeachingSkillsInspection — Action findings attribution', () => {
  it('attributes findings to the right sceneId/actionId for slide, quiz, interactive AND pbl', () => {
    const scenes = [
      // slide: a dangling element reference (reference category) next to a
      // valid action — the valid one must NOT be flagged.
      slideWith(
        's-slide',
        [
          { id: 'a-slide-ok', type: 'speech', text: 'Narration.' },
          { id: 'a-slide-bad', type: 'spotlight', elementId: 'el-missing' },
        ],
        ['el-real'],
      ),
      // quiz: a structurally invalid canonical action (wrong field kind).
      bareScene('s-quiz', 'quiz', [
        {
          id: 'a-quiz-bad',
          type: 'wb_draw_code',
          language: 'ts',
          code: 'x',
          x: 'not-a-number',
          y: 1,
        },
      ]),
      // interactive: a discussion whose agent is not in the roster.
      bareScene('s-interactive', 'interactive', [
        { id: 'a-int-bad', type: 'discussion', topic: 't', agentId: 'agent-nobody' },
      ]),
      // pbl: TWO unknown types — the historical corpus shape.
      bareScene('s-pbl', 'pbl', [
        { id: 'a-pbl-unknown-1', type: 'legacy_confetti_burst', intensity: 11 },
        { id: 'a-pbl-unknown-2', type: 'legacy_dramatic_zoom' },
      ]),
    ];

    const inspection = buildStageTeachingSkillsInspection(scenes, FLOW, { stage: STAGE });
    const byScene = new Map(inspection.scenes.map((scene) => [scene.sceneId, scene]));

    const slide = byScene.get('s-slide')!;
    expect(slide.actionCount).toBe(2);
    expect(slide.actionFindings).toEqual([
      {
        actionId: 'a-slide-bad',
        actionType: 'spotlight',
        code: 'ACTION_REFERENCE_INVALID',
        message: expect.stringContaining('el-missing'),
      },
    ]);
    // The fold: the same finding reaches the per-Scene failures channel once.
    expect(slide.failures.map((failure) => failure.code)).toEqual(['ACTION_REFERENCE_INVALID']);

    const quiz = byScene.get('s-quiz')!;
    expect(quiz.actionCount).toBe(1);
    expect(quiz.actionFindings).toHaveLength(1);
    expect(quiz.actionFindings[0]).toMatchObject({
      actionId: 'a-quiz-bad',
      code: 'ACTION_STRUCTURE_INVALID',
    });

    const interactive = byScene.get('s-interactive')!;
    expect(interactive.actionCount).toBe(1);
    expect(interactive.actionFindings[0]).toMatchObject({
      actionId: 'a-int-bad',
      code: 'ACTION_REFERENCE_INVALID',
    });
    // ...and the roster passed via options is really used: the same discussion
    // against an agent the stage DOES carry raises no finding.
    const withRosterAgent = buildStageTeachingSkillsInspection(
      [
        bareScene('s-int-2', 'interactive', [
          { id: 'a-int-ok', type: 'discussion', topic: 't', agentId: 'agent-roster-1' },
        ]),
      ],
      FLOW,
      { stage: STAGE },
    );
    expect(withRosterAgent.scenes[0]!.actionFindings).toEqual([]);

    // pbl: the unknown type refusal, per action, on that Scene only.
    const pbl = byScene.get('s-pbl')!;
    expect(pbl.actionCount).toBe(2);
    expect(pbl.actionFindings.map((finding) => finding.actionId)).toEqual([
      'a-pbl-unknown-1',
      'a-pbl-unknown-2',
    ]);
    expect(
      new Set(pbl.actionFindings.map((finding) => finding.code + ':' + finding.actionType)),
    ).toEqual(
      new Set([
        'ACTION_TYPE_UNKNOWN:legacy_confetti_burst',
        'ACTION_TYPE_UNKNOWN:legacy_dramatic_zoom',
      ]),
    );
    // Deduped in the failures channel: two flagged rows, one chip.
    expect(pbl.failures.map((failure) => failure.code)).toEqual(['ACTION_TYPE_UNKNOWN']);
  });

  it('reports the submit-gate view: allowUnknownTypes is never set here', () => {
    // The reviewer surface shows what the submit gate would refuse — an
    // unknown type is a finding even though the builder COULD have asked the
    // validator to skip it. (Pinned on pbl, the lenient write-barrier type.)
    const inspection = buildStageTeachingSkillsInspection(
      [bareScene('s-pbl', 'pbl', [{ id: 'a-x', type: 'legacy_confetti_burst' }])],
      FLOW,
      { stage: STAGE },
    );
    expect(inspection.scenes[0]!.actionFindings.map((finding) => finding.code)).toEqual([
      'ACTION_TYPE_UNKNOWN',
    ]);
  });
});

describe('W5 buildStageTeachingSkillsInspection — identity-only payload (TAE-RQ-027)', () => {
  it('the serialized inspection carries none of text, content, code, latex, topic, state values', () => {
    const SENTINELS = {
      text: 'SENTINEL_NARRATION_TEXT',
      content: 'SENTINEL_WB_CONTENT',
      code: 'SENTINEL_WB_CODE',
      latex: 'SENTINEL_LATEX',
      topic: 'SENTINEL_TOPIC',
      state: 'SENTINEL_WIDGET_STATE',
    } as const;
    const scenes = [
      slideWith(
        's-slide',
        [
          // Valid actions whose CONTENT fields carry sentinels — they render in
          // the timeline, but must never ride the governance payload.
          { id: 'a-1', type: 'speech', text: SENTINELS.text },
          { id: 'a-2', type: 'wb_draw_text', content: SENTINELS.content, x: 1, y: 1 },
          { id: 'a-3', type: 'wb_draw_code', language: 'ts', code: SENTINELS.code, x: 1, y: 1 },
          { id: 'a-4', type: 'wb_draw_latex', latex: SENTINELS.latex, x: 1, y: 1 },
          { id: 'a-5', type: 'widget_setState', target: '#x', state: { secret: SENTINELS.state } },
          // A finding generator, so finding messages actually populate.
          { id: 'a-6', type: 'discussion', topic: SENTINELS.topic, agentId: 'agent-nobody' },
        ],
        ['el-real'],
      ),
      bareScene('s-interactive', 'interactive', [
        { id: 'a-7', type: 'legacy_confetti_burst', shout: SENTINELS.text },
      ]),
    ];

    const serialized = JSON.stringify(
      buildStageTeachingSkillsInspection(scenes, FLOW, { stage: STAGE }),
    );
    // Findings exist, so the assertion proves absence despite populated paths.
    expect(serialized).toContain('ACTION_TYPE_UNKNOWN');
    expect(serialized).toContain('ACTION_REFERENCE_INVALID');
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized, `the payload must not carry ${sentinel}`).not.toContain(sentinel);
    }
  });
});

describe('W5 buildStageTeachingSkillsInspection — invoke, never reimplement', () => {
  it('scene-inspection.ts imports validateSceneActionStructure and holds no Action validator of its own', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/server/teaching-package/scene-inspection.ts'),
      'utf8',
    );
    // The invoke: exactly the pattern the W12 Skill validators established.
    expect(source).toMatch(
      /import\s*\{[^}]*\bvalidateSceneActionStructure\b[^}]*\}\s*from\s*'@\/lib\/server\/teaching-package\/action-validation'/,
    );
    // No second copy: the DSL primitives the W3 module wraps may not appear
    // here directly — that would be Action-validation logic outside the one
    // module three callers already share.
    expect(source).not.toMatch(/\bisActionType\b/);
    expect(source).not.toMatch(/\bvalidateAction\b/);
  });
});

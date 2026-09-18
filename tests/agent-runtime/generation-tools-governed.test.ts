import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '@earendil-works/pi-agent-core';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
} from '@/lib/persistence/teaching-package';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { buildGenerationTools } from '@/lib/server/agent-runtime/generation-tools';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../teaching-package/../agent-runtime/_stage-fixtures';

/**
 * Module 3/4 W4 integration (TAE-RQ-018/019/020 + §7.4.4, plan §7.4): the
 * agent regeneration tools on a GOVERNED Stage generate under the
 * authoritative context — the assembled prompts demonstrably carry the exact
 * Flow Instructions and the resolved Skill definitions — or refuse. Carrier
 * preservation alone is never accepted as proof: that is precisely the
 * false-governance pattern W4 exists to close, so every "governed" assertion
 * here is a PROMPT assertion, not a metadata one.
 *
 * The governed-context resolution runs the REAL default wiring
 * (resolveGovernedRegenerationContextForStage → durable marker → flow →
 * skills) against this suite's PGlite.
 */

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };

const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'Open by connecting the goal to the learner.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'Consolidate the outcome with the cards.',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
];

const ACTIONS_PROMPT = /^# (Slide|Quiz|Interactive|PBL).*Action Generator/m;
const CONTENT_REPLY = JSON.stringify({
  elements: [
    { type: 'text', content: 'Regenerated body', left: 100, top: 100, width: 600, height: 60 },
  ],
  background: { type: 'solid', color: '#ffffff' },
  remark: '',
});
const ACTIONS_REPLY = JSON.stringify([{ type: 'text', content: 'Governed narration.' }]);

interface Captured {
  system: string;
  user: string;
}

function governedScene(id: string, stageId: string, order: number): AppScene {
  const base = makeSlideScene(id, stageId, order);
  return {
    ...base,
    teachingStage: { key: FLOW[0]!.stage, flowIndex: 0 },
    teachingSkills: {
      classification: 'instructional' as const,
      primary: FEYNMAN,
      supporting: [LECTURE],
    },
    learningObjectives: [],
    content: {
      ...base.content,
      canvas: {
        ...(base.content as { canvas: object }).canvas,
        elements: [
          {
            id: 'el-1',
            type: 'text',
            content: 'Original body',
            left: 0,
            top: 0,
            width: 100,
            height: 10,
            rotate: 0,
          },
        ],
      },
    },
    actions: [{ id: 'a-old', type: 'speech', text: 'Old narration.' }] as never,
  } as unknown as AppScene;
}

describe('generation tools on a governed Stage (W4)', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w4-${(counter += 1)}`;
  const qp = () => pool as never;
  const calls: Captured[] = [];

  function makeStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  function tools() {
    const built = buildGenerationTools({
      store: makeStore() as never,
      stageAccess: async () => ({ kind: 'owned' as const }),
      sessionId: 'session-w4',
      onCheckpoint: vi.fn(),
      synthesizeTts: vi.fn(async () => ({
        available: true,
        changed: false,
        generated: 0,
        skipped: 0,
        failed: [],
      })),
      aiCall: (async (system: string, user: string) => {
        calls.push({ system, user });
        return ACTIONS_PROMPT.test(system) ? ACTIONS_REPLY : CONTENT_REPLY;
      }) as never,
    });
    const find = (name: string): AgentTool<never, never> => {
      const tool = built.find((item) => item.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool;
    };
    return { generateActions: find('generate_actions'), generateScene: find('generate_scene') };
  }

  /**
   * Seed a stage whose scene 1 is governed at position 0, plus a version +
   * governed attempt (contract marker + flow). Returns ids.
   */
  async function seedGovernedStage(options: { contract?: string | null } = {}): Promise<{
    stageId: string;
    versionId: string;
  }> {
    const stageId = nextId('stage');
    const store = makeStore();
    await store.saveDocument(
      makeDocument(
        stageId,
        'W4',
        [
          governedScene('scene-w4-1', stageId, 1),
          // Scene 2 has NO teachingStage: a governed regeneration of it cannot
          // resolve a context and must refuse.
          makeSlideScene('scene-w4-2', stageId, 2),
        ],
        // The governed pipeline persists the outline record WITH its W10
        // carriers — outlineFromScene spreads this record, which is how the
        // Skill identity reaches the regeneration prompt.
        {
          outlines: [
            {
              id: 'scene-w4-1',
              order: 1,
              title: 'Opening',
              type: 'slide' as const,
              description: 'Opening brief',
              keyPoints: [],
              teachingStage: { key: FLOW[0]!.stage, flowIndex: 0 },
              teachingSkills: {
                classification: 'instructional' as const,
                primary: FEYNMAN,
                supporting: [LECTURE],
              },
            },
            {
              id: 'scene-w4-2',
              order: 2,
              title: 'Second',
              type: 'slide' as const,
              description: 'Second brief',
              keyPoints: [],
            },
          ],
          requirement: 'W4',
          generationComplete: true,
          createdAt: 1,
          updatedAt: 1,
        } as never,
      ),
    );
    const item = { type: 'lesson' as const, id: nextId('li') };
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    const contract = options.contract === undefined ? 'kafuo.teaching-skills.v1' : options.contract;
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'actor-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      ...(contract ? { teachingSkillsContract: contract } : {}),
      inputSnapshot: {
        learningItem: item,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: FLOW,
      },
      now: 1,
    });
    return { stageId, versionId };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w4-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    calls.length = 0;
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('generate_actions on a governed Scene assembles its prompt under the exact governed context (the headline)', async () => {
    const { stageId } = await seedGovernedStage();
    const { generateActions } = tools();

    const outcome = await generateActions.execute(
      'call-1',
      { stageId, order: 1 } as never,
      undefined,
    );
    expect((outcome.details as { error?: unknown }).error).toBeUndefined();

    // THE assertion: the assembled Action prompt carries the authoritative
    // context — exact Flow Instructions, model identity, position, and the
    // resolved Primary AND Supporting Skill definitions (not just ids).
    const actionsPrompt = calls.find(({ system }) => ACTIONS_PROMPT.test(system))!;
    expect(actionsPrompt.system).toContain('## Teaching Model Flow Authority');
    expect(actionsPrompt.system).toContain('Open by connecting the goal to the learner.');
    expect(actionsPrompt.system).toContain('Teaching Model: g5@g5.v1');
    expect(actionsPrompt.system).toContain('Flow position:  lesson_introduction (position 1)');
    expect(actionsPrompt.system).toContain('PRIMARY SKILL: feynman-learning@v1');
    expect(actionsPrompt.system).toContain('SUPPORTING SKILL: lecture-style@v1');
    // The definitions are the resolved SKILL.md bodies, not placeholders.
    expect(actionsPrompt.system).toMatch(/Feynman/);
    expect(actionsPrompt.system).toMatch(/Masterclass/);
  });

  it('generate_actions replaces only the Actions; lineage survives and a fresh generation baseline is stamped (TAE-RQ-019 + §7.4.4)', async () => {
    const { stageId } = await seedGovernedStage();
    const store = makeStore();
    const before = (await store.loadDocument(stageId))!.scenes[0]!;
    const { generateActions } = tools();

    await generateActions.execute('call-1', { stageId, order: 1 } as never, undefined);

    const after = (await store.loadDocument(stageId))!.scenes[0]!;
    expect(after.id).toBe(before.id);
    expect(after.content).toEqual(before.content);
    expect(after.teachingStage).toEqual(before.teachingStage);
    expect(after.teachingSkills).toEqual(before.teachingSkills);
    expect(after.learningObjectives).toEqual(before.learningObjectives);
    // Actions replaced with the regenerated canonical sequence.
    expect((after.actions as Array<{ text?: string }>)[0]!.text).toBe('Governed narration.');
    // New generation-origin baseline; the Scene derives current.
    expect(after.alignmentBaseline?.origin).toBe('generation');
    expect(deriveSceneAlignment(after)).toMatchObject({ state: 'current', aligned: true });
  });

  it('generate_scene on a governed Stage regenerates under the context and preserves position + Skills (TAE-RQ-020)', async () => {
    const { stageId } = await seedGovernedStage();
    const store = makeStore();
    const before = (await store.loadDocument(stageId))!.scenes[0]!;
    const { generateScene } = tools();

    const outcome = await generateScene.execute(
      'call-2',
      {
        stageId,
        order: 1,
        title: 'Opening',
        brief: 'Rewrite the opening slide',
        type: 'slide',
      } as never,
      undefined,
    );
    expect((outcome.details as { error?: unknown }).error).toBeUndefined();

    // Content AND action prompts ran governed: the Skill definitions reached
    // the content pass, the Flow block the action pass.
    const contentPrompt = calls.find(({ system }) => !ACTIONS_PROMPT.test(system))!;
    expect(contentPrompt.system).toContain('PRIMARY SKILL: feynman-learning@v1');
    const actionsPrompt = calls.find(({ system }) => ACTIONS_PROMPT.test(system))!;
    expect(actionsPrompt.system).toContain('Open by connecting the goal to the learner.');

    const after = (await store.loadDocument(stageId))!.scenes[0]!;
    // No reselection: the flow position and Skill assignment are identical.
    expect(after.teachingStage).toEqual(before.teachingStage);
    expect(after.teachingSkills).toEqual(before.teachingSkills);
    expect(after.alignmentBaseline?.origin).toBe('generation');
    expect(deriveSceneAlignment(after)).toMatchObject({ state: 'current' });
  });

  it('refuses on a governed Stage whose context cannot be resolved, writing nothing', async () => {
    const { stageId } = await seedGovernedStage();
    const store = makeStore();
    const before = JSON.stringify((await store.loadDocument(stageId))!.scenes);
    const { generateActions } = tools();

    // Scene 2 has no teachingStage: no Flow entry resolves.
    const outcome = await generateActions.execute(
      'call-3',
      { stageId, order: 2 } as never,
      undefined,
    );
    expect((outcome.details as { error?: unknown }).error).toBeDefined();
    const text = (outcome.content[0] as { text: string }).text;
    expect(text).toContain('refused on a governed Stage');
    // Nothing was written — the document is byte-unchanged.
    expect(JSON.stringify((await store.loadDocument(stageId))!.scenes)).toBe(before);
  });

  it('non-governed Stage (tier B: flow, carriers, NO marker): prompts and writes stay legacy', async () => {
    const { stageId } = await seedGovernedStage({ contract: null });
    const store = makeStore();
    const { generateActions } = tools();

    const outcome = await generateActions.execute(
      'call-4',
      { stageId, order: 1 } as never,
      undefined,
    );
    expect((outcome.details as { error?: unknown }).error).toBeUndefined();

    const actionsPrompt = calls.find(({ system }) => ACTIONS_PROMPT.test(system))!;
    expect(actionsPrompt.system).not.toContain('Teaching Model Flow Authority');
    expect(actionsPrompt.system).not.toContain('PRIMARY SKILL:');
    // No baseline fabricated for a tier-B regeneration.
    const after = (await store.loadDocument(stageId))!.scenes[0]!;
    expect('alignmentBaseline' in after).toBe(false);
  });

  it('an UNCLASSIFIED governed Scene regenerates with NO baseline — validation-required, never fabricated stale (§7.4.4)', async () => {
    const { stageId } = await seedGovernedStage();
    const store = makeStore();
    // Strip the classification (and the baseline) from scene 1: a malformed
    // carrier the Stage-1 gate would normally refuse.
    const document = (await store.loadDocument(stageId))!;
    const { alignmentBaseline: _b, teachingSkills: _s, ...carrierless } = document.scenes[0]!;
    void _b;
    void _s;
    await store.putScene(stageId, {
      ...carrierless,
      teachingSkills: { primary: FEYNMAN },
    } as AppScene);

    const { generateActions } = tools();
    const outcome = await generateActions.execute(
      'call-5',
      { stageId, order: 1 } as never,
      undefined,
    );
    expect((outcome.details as { error?: unknown }).error).toBeUndefined();

    const after = (await store.loadDocument(stageId))!.scenes[0]!;
    expect('alignmentBaseline' in after).toBe(false);
    expect(deriveSceneAlignment(after)).toMatchObject({
      state: 'validation-required',
      aligned: false,
    });
  });

  it('the §8 sweep: every W4 write/generation path takes a governed Scene in and yields a governed Scene out', async () => {
    // Plan §8 rows exercised here, end to end on fresh stages: grant-delegated
    // scene PUT (carry-forward), Action-only regenerate, agent generate_scene.
    // The generation rows additionally require the governed CONTEXT — asserted
    // by the prompt-capture tests above, because carriers alone would score
    // the false-governance pattern as a pass. The remaining §8 rows are
    // pinned where they live: initial generation (W1 AC-002 harness), Stage
    // regeneration (generation-runner suites), clone and materially-changed
    // successors (stage-clone / lifecycle / submit-skill-gate suites), and
    // the browser/Workbench legacy rows (non-kafuo-call-sites +
    // scene-skill-context byte-identity pins).
    for (const path of ['grant-put', 'action-only', 'full-scene'] as const) {
      const { stageId } = await seedGovernedStage();
      const store = makeStore();
      const before = (await store.loadDocument(stageId))!.scenes[0]!;
      expect(before.teachingStage).toBeDefined();
      expect(before.teachingSkills).toBeDefined();

      if (path === 'grant-put') {
        const { alignmentBaseline: _kept, ...lineageLess } = before;
        void _kept;
        const stripped = makeSlideScene(before.id, stageId, 1);
        await store.putScene(stageId, { ...stripped, actions: before.actions } as AppScene);
        void lineageLess;
      } else if (path === 'action-only') {
        const { generateActions } = tools();
        await generateActions.execute(`sweep-`, { stageId, order: 1 } as never, undefined);
      } else {
        const { generateScene } = tools();
        await generateScene.execute(
          `sweep-`,
          { stageId, order: 1, title: 'Opening', brief: 'Rewritten', type: 'slide' } as never,
          undefined,
        );
      }

      const after = (await store.loadDocument(stageId))!.scenes[0]!;
      expect(after.teachingStage, path).toEqual(before.teachingStage);
      expect(after.teachingSkills, path).toEqual(before.teachingSkills);
      // Every governed OUT state is coherent: the classified regeneration
      // paths stamped a fresh baseline; the grant-put row kept exactly what
      // the stored Scene carried (carry-forward retains, never fabricates).
      if (path === 'grant-put') {
        expect('alignmentBaseline' in after).toBe('alignmentBaseline' in before);
      } else {
        expect('alignmentBaseline' in after, path).toBe(true);
      }
      calls.length = 0;
    }
  });
});

/**
 * Module 3/4 W6.7 + W6.9 — the preservation and no-inference rows of plan §3.7
 * that had no pin of their own (plan §7.6 items 7 and 9):
 *
 * - W6.7 (TAE-RQ-029): a same-model clone-only successor preserves each
 *   Scene's Action VALUES, ARRAY ORDER, Teaching Stage and Teaching Skills
 *   exactly. stage-clone.test.ts pins the stage fields, media refs and the
 *   actions of a carrier-free fixture; the carriers (the Module-2 additive
 *   fields this gate exists to protect) are pinned HERE.
 *
 * - W6.9 (TAE-RQ-031/032): historical usability and no inferred governance.
 *   A document whose Scenes carry rich Action text, unknown Action types,
 *   Scene titles and playback-shaped content loads and saves through the real
 *   write barrier with every carrier ABSENT — nothing derives Skills,
 *   Teaching Stage or flow lineage from Action text, type name, Scene type,
 *   title or content. (Playing unknown types is pinned by
 *   tests/action/unknown-type-noop.test.ts — cited, not duplicated.)
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { cloneStageForSuccessor } from '@/lib/server/teaching-package/stage-clone';
import type { AppScene } from '@/lib/types/stage';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

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

const SOURCE_STAGE = 'stage-w6-preservation';
const FIXED_NOW = 1_700_000_000_000;

describe('W6.7 — a clone-only successor preserves Actions, order, Stage and Skills exactly', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w6-preservation-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('cloneStageForSuccessor copies Action values and array order, Teaching Stage and Skills, byte-for-byte', async () => {
    /** A governed scene whose ordered Actions deliberately interleave types. */
    const governed: AppScene = {
      ...makeSlideScene('scene-governed', SOURCE_STAGE, 1),
      teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      teachingSkills: {
        classification: 'instructional',
        primary: { skillId: 'feynman-learning', version: 'v1' },
        supporting: [{ skillId: 'social-emotional-learning', version: 'v1' }],
      },
      alignmentBaseline: {
        origin: 'reviewer-confirmation',
        actorRef: 'reviewer-1',
        classification: 'instructional',
        fingerprint: '0'.repeat(64),
        establishedAt: FIXED_NOW,
        primary: { skillId: 'feynman-learning', version: 'v1' },
        supporting: [{ skillId: 'social-emotional-learning', version: 'v1' }],
      },
      actions: [
        { id: 'a-1', type: 'speech', text: 'First.' },
        { id: 'a-2', type: 'spotlight', elementId: 'el-1' },
        { id: 'a-3', type: 'speech', text: 'Second.' },
        { id: 'a-4', type: 'wb_open' },
      ] as never,
    } as AppScene;
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    await store.saveDocument(makeDocument(SOURCE_STAGE, 'W6', [governed]));

    const { stageId } = await cloneStageForSuccessor(store, SOURCE_STAGE, {
      producerRef: 'tpv-w6',
      now: FIXED_NOW + 1000,
    });

    const clone = (await store.loadDocument(stageId))!;
    const clonedScene = clone.scenes.find((scene) => scene.id === 'scene-governed')!;
    // Actions: values AND order, exactly — the successor is a verbatim copy.
    expect(clonedScene.actions).toEqual(governed.actions);
    expect((clonedScene.actions ?? []).map((action) => (action as { id: string }).id)).toEqual([
      'a-1',
      'a-2',
      'a-3',
      'a-4',
    ]);
    // Teaching Stage: the authoritative flow position rides the clone.
    expect(clonedScene.teachingStage).toEqual({ key: 'lesson_introduction', flowIndex: 0 });
    // Teaching Skills: classification, Primary AND Supporting survive exactly.
    expect(clonedScene.teachingSkills).toEqual(governed.teachingSkills);
    // And the alignment evidence baseline with them (the §8 clone row).
    expect(clonedScene.alignmentBaseline).toEqual(governed.alignmentBaseline);
  });
});

describe('W6.9 — historical documents load and save; nothing infers governance from content', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w6-legacy-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('a carrier-free historical document (rich text, unknown types, playback-shaped content) round-trips with carriers ABSENT', async () => {
    // Prose that BEGS to be mistaken for governance: skill-sounding words in
    // Action text, a flow-sounding title, teaching-shaped content. None of it
    // may produce a teachingStage, teachingSkills or alignmentBaseline key.
    // Unknown Action types ride the interactive scene — the write barrier's
    // slide path is strict (the F-2 split), which is itself the historical
    // shape: legacy unknown types persist on interactive/pbl Scenes.
    const legacy: AppScene[] = [
      {
        ...makeSlideScene('scene-legacy', SOURCE_STAGE, 1, 'lesson_introduction maybe?'),
        actions: [
          { id: 'a-legacy-2', type: 'speech', text: 'Use the feynman-learning skill here.' },
          { id: 'a-legacy-2b', type: 'spotlight', elementId: 'el-missing' },
        ] as never,
      } as AppScene,
      {
        id: 'scene-legacy-interactive',
        stageId: SOURCE_STAGE,
        title: 'Practice with the Primary Skill',
        order: 2,
        type: 'interactive',
        content: { type: 'interactive', url: 'https://example.test/widget' },
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        actions: [
          { id: 'a-legacy-1', type: 'legacy_confetti_burst', intensity: 11 },
          { id: 'a-legacy-3', type: 'legacy_dramatic_zoom', next_card: true },
          { id: 'a-legacy-4', type: 'request_handoff' },
        ],
      } as unknown as AppScene,
    ];
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    await store.saveDocument(makeDocument(SOURCE_STAGE, 'Legacy', legacy));

    // Load: readable, actions intact in order, unknown types preserved.
    const loaded = (await store.loadDocument(SOURCE_STAGE))!;
    expect(loaded.scenes.map((scene) => scene.id)).toEqual([
      'scene-legacy',
      'scene-legacy-interactive',
    ]);
    for (const scene of loaded.scenes) {
      expect('teachingStage' in scene).toBe(false);
      expect('teachingSkills' in scene).toBe(false);
      expect('alignmentBaseline' in scene).toBe(false);
    }
    expect((loaded.scenes[1]!.actions as Array<{ type: string }>)[0]!.type).toBe(
      'legacy_confetti_burst',
    );

    // Save again through the real barrier (loadDocument → saveDocument): the
    // round-trip still invents nothing.
    await store.saveDocument(loaded);
    const reloaded = (await store.loadDocument(SOURCE_STAGE))!;
    for (const scene of reloaded.scenes) {
      expect('teachingStage' in scene).toBe(false);
      expect('teachingSkills' in scene).toBe(false);
      expect('alignmentBaseline' in scene).toBe(false);
    }
    expect(reloaded.scenes[1]!.actions).toEqual(loaded.scenes[1]!.actions);
  });
});

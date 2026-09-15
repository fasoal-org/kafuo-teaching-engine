import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDocument, AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { cloneStageForSuccessor } from '@/lib/server/teaching-package/stage-clone';
import type { AppScene } from '@/lib/types/stage';
import { FIXED_NOW, makeOutline, makeSlideScene } from '../agent-runtime/_stage-fixtures';

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

const SOURCE_STAGE = 'stage-clone-source';

function richDocument(stageId: string): AppDocument {
  const slide = makeSlideScene('scene-slide', stageId, 1, 'Slide');
  // Image element pointing at server-generated media under the SOURCE stage id.
  (slide.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
    id: 'el-image',
    type: 'image',
    src: `/api/classroom-media/${stageId}/media/img-x-a1b2c3.png`,
  });
  const quiz = {
    id: 'scene-quiz',
    stageId,
    title: 'Quiz',
    order: 2,
    type: 'quiz',
    content: { type: 'quiz', questions: [] },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as AppScene;
  const interactive = {
    id: 'scene-interactive',
    stageId,
    title: 'Interactive',
    order: 3,
    type: 'interactive',
    content: { type: 'interactive', url: 'https://example.test/widget' },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as AppScene;
  const pbl = {
    id: 'scene-pbl',
    stageId,
    title: 'PBL',
    order: 4,
    type: 'pbl',
    content: {
      type: 'pbl',
      projectConfig: {
        projectInfo: { title: 'Project', description: 'Build it' },
        agents: [],
        issueboard: { agent_ids: [], issues: [], current_issue_id: null },
        chat: { messages: [] },
      },
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } as AppScene;
  const narrated = makeSlideScene('scene-narrated', stageId, 5, 'Narrated');
  // The DSL type spells the narrated pair as audioId (+ optional audioUrl on
  // the app's runtime shape); the actions array is cast like whiteboards.
  narrated.actions = [
    {
      id: 'a-speech',
      type: 'speech',
      text: 'Welcome',
      audioId: `tts_s5_a-speech`,
      audioUrl: `/api/classroom-media/${stageId}/audio/tts_s5_a-speech.mp3`,
    },
  ] as never;
  narrated.whiteboards = [
    {
      id: 'wb-1',
      canvas: { id: 'wb-canvas', elements: [] },
    },
  ] as never;
  narrated.outlineId = 'outline-narrated';
  const outline: AppDocumentOutline = {
    ...makeOutline('Teach the thing'),
    outlines: [{ id: 'outline-narrated', title: 'Narrated', sceneType: 'slide' } as never],
    producer: 'client',
  };
  return {
    stage: {
      id: stageId,
      name: 'Rich approved course',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      description: 'desc',
      languageDirective: 'Answer in Egyptian Arabic',
      style: 'vivid',
      interactiveMode: true,
      taskEngineMode: false,
      whiteboard: [{ id: 'stage-wb', canvas: { id: 'c', elements: [] } }] as never,
      videoManifest: { entries: [] } as never,
      agentIds: ['agent-alpha', 'agent-beta'],
      generatedAgentConfigs: [{ agentId: 'agent-alpha', name: 'Alpha' }] as never,
    },
    scenes: [slide, quiz, interactive, pbl, narrated],
    outline,
  };
}

describe('cloneStageForSuccessor', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://stage-clone-${randomUUID()}`);
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

  async function serviceStore() {
    return getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  }

  it('clones a rich stage field-for-field and scene-for-scene', async () => {
    const store = await serviceStore();
    const source = richDocument(SOURCE_STAGE);
    await store.saveDocument(source);

    const { stageId } = await cloneStageForSuccessor(store, SOURCE_STAGE, {
      producerRef: 'tpv-source-1',
      now: FIXED_NOW + 1000,
    });
    expect(stageId).not.toBe(SOURCE_STAGE);
    expect(stageId.startsWith('stage-')).toBe(true);

    const clone = await store.loadDocument(stageId);
    expect(clone).not.toBeNull();
    // Every stage field survives, with identity and timestamps rewritten.
    expect(clone!.stage).toEqual({
      ...source.stage,
      id: stageId,
      createdAt: FIXED_NOW + 1000,
      updatedAt: FIXED_NOW + 1000,
    });
    expect(clone!.stage.languageDirective).toBe('Answer in Egyptian Arabic');
    expect(clone!.stage.style).toBe('vivid');
    expect(clone!.stage.interactiveMode).toBe(true);
    expect(clone!.stage.whiteboard).toEqual(source.stage.whiteboard);
    expect(clone!.stage.videoManifest).toEqual(source.stage.videoManifest);
    expect(clone!.stage.agentIds).toEqual(['agent-alpha', 'agent-beta']);
    expect(clone!.stage.generatedAgentConfigs).toEqual(source.stage.generatedAgentConfigs);

    // Every scene survives with the same ids and the new stageId.
    expect(clone!.scenes.map((scene) => scene.id)).toEqual(source.scenes.map((scene) => scene.id));
    for (const scene of clone!.scenes) {
      expect(scene.stageId).toBe(stageId);
    }
    const clonedNarrated = clone!.scenes.find((scene) => scene.id === 'scene-narrated')!;
    expect(clonedNarrated.outlineId).toBe('outline-narrated');
    expect(clonedNarrated.actions).toEqual(source.scenes[4]!.actions);
    expect(clonedNarrated.whiteboards).toEqual(source.scenes[4]!.whiteboards);
    // Media references keep pointing at the SOURCE stage's files, verbatim.
    const clonedSlide = clone!.scenes.find((scene) => scene.id === 'scene-slide')! as {
      content: { canvas: { elements: Array<{ src?: string }> } };
    };
    expect(clonedSlide.content.canvas.elements[0]!.src).toBe(
      `/api/classroom-media/${SOURCE_STAGE}/media/img-x-a1b2c3.png`,
    );

    // The outline is stamped as a server-job product of the version.
    expect(clone!.outline).toMatchObject({
      requirement: 'Teach the thing',
      producer: 'server-job',
      producerRef: 'tpv-source-1',
      generationComplete: true,
    });
  });

  it('leaves the source document byte-identical', async () => {
    const store = await serviceStore();
    await store.saveDocument(richDocument(SOURCE_STAGE));
    // loadDocument migrates and stamps dslVersion on read, so the before/after
    // comparison must be between two loads, not against the fixture.
    const before = await store.loadDocument(SOURCE_STAGE);

    await cloneStageForSuccessor(store, SOURCE_STAGE, {
      producerRef: 'tpv-source-1',
      now: FIXED_NOW + 1000,
    });

    const after = await store.loadDocument(SOURCE_STAGE);
    expect(after).toEqual(before);
  });

  it('retries on an id collision (reserved-document) and re-mints', async () => {
    const store = await serviceStore();
    await store.saveDocument(richDocument(SOURCE_STAGE));
    // `reserved-document` fires when the id exists in document_stages WITHOUT a
    // claimed stage_meta row — an owner-matched live row would be an overwrite.
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ('stage-taken', 'Occupied', 1, 1, '{}'::jsonb)`,
    );

    const ids = ['stage-taken', 'stage-free'];
    const { stageId } = await cloneStageForSuccessor(store, SOURCE_STAGE, {
      producerRef: 'tpv-source-1',
      createStageId: () => ids.shift()!,
    });
    expect(stageId).toBe('stage-free');
    expect(await store.loadDocument('stage-free')).not.toBeNull();
  });

  it('throws STAGE_NOT_LIVE for an unloadable source', async () => {
    const store = await serviceStore();
    await expect(
      cloneStageForSuccessor(store, 'stage-absent', { producerRef: 'tpv-x' }),
    ).rejects.toMatchObject({ code: 'STAGE_NOT_LIVE', status: 422 });
  });
});

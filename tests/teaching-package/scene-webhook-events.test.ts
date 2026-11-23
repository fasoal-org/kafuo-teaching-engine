/**
 * Agent API wave B — the scene webhook events over PGlite: every send point
 * enqueues exactly one `teaching_package.scene_changed` (plus one
 * `teaching_package.narration_audio_failed` when the written scene carries the
 * mark) inside the write's transaction, and a failed write enqueues nothing.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  commitSceneInsertion,
  startSceneInsertion,
} from '@/lib/server/teaching-package/scene-insertion-store';
import { regenerateSceneNarrationAudio } from '@/lib/server/teaching-package/scene-narration-audio';
import {
  commitSceneRegeneration,
  restoreSceneRegeneration,
  startSceneRegeneration,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import {
  enqueueStageNarrationAudioFailures,
  missingAudioLineIndexes,
} from '@/lib/server/teaching-package/scene-webhook-events';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { SpeechAction } from '@/lib/types/action';
import type { AppScene, Scene } from '@/lib/types/stage';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
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

const STAGE = 'stage-swe';
const TENANT = 'tenant-swe';
const VERSION = 'tpv-swe';
const ITEM = { type: 'lesson' as const, id: 'li-swe' };
const AUDIO = (id: string) => `/api/classroom-media/${STAGE}/audio/tts-${id}-abc.mp3`;
const FAILED = {
  code: 'NARRATION_AUDIO_FAILED',
  message: 'narration audio could not be generated for 1 of 2 spoken line(s)',
};

function line(id: string, audio = false): SpeechAction {
  return { id, type: 'speech', text: `سطر ${id}`, ...(audio ? { audioId: AUDIO(id) } : {}) };
}

function narrated(id: string, order: number, actions: SpeechAction[], marked = false): AppScene {
  return {
    ...makeSlideScene(id, STAGE, order),
    actions,
    ...(marked ? { generationIssues: [FAILED] } : {}),
  } as AppScene;
}

describe('scene webhook events', () => {
  let pool: PGlitePool;
  const tx = () => pool as unknown as ConnectableQueryable;

  function store() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      // Fixture writes only: the guard's own `edited` events are covered in
      // scene-edit-webhook-events.test.ts, so the setup does not send them.
      mutationFence: teachingPackageStageGuardFence(undefined, { sceneEvents: false }),
    });
  }

  async function deliveries(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
    const result = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM teaching_package_webhook_deliveries
        WHERE tenant_id = $1 ORDER BY sequence`,
      [TENANT],
    );
    return result.rows.map((row) => ({ type: row.event_type, data: row.payload }));
  }

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await store().saveDocument(
      makeDocument(STAGE, 'swe', [
        narrated('s1', 1, [line('a1', true), line('a2', true)]),
        makeSlideScene('s2', STAGE, 2),
      ]),
    );
    await insertVersion(pool as never, {
      id: VERSION,
      aggregate: { tenantId: TENANT, learningItem: ITEM },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
  });

  async function startRegeneration(key = 'key-1') {
    const started = await startSceneRegeneration(tx(), {
      tenantId: TENANT,
      versionId: VERSION,
      stageId: STAGE,
      sceneId: 's1',
      idempotencyKey: key,
      requestDigest: 'd',
      instruction: 'instruction',
      reason: 'reason',
      actorRef: 'agent:42',
      sessionRef: null,
    });
    if (started.kind !== 'started') throw new Error(started.kind);
    return started.regeneration;
  }

  const commitContext = (row: Awaited<ReturnType<typeof startRegeneration>>) => ({
    regenerationId: row.id,
    attemptToken: row.attemptToken,
    tenantId: TENANT,
    versionId: VERSION,
    stageId: STAGE,
    sceneId: 's1',
    baseSceneRev: row.baseSceneRev,
    actorRef: 'agent:42',
    reason: 'reason',
  });

  it('a regeneration commit sends scene_changed, and narration_audio_failed for a marked slide', async () => {
    const row = await startRegeneration();
    await commitSceneRegeneration(
      tx(),
      commitContext(row),
      narrated('s1', 1, [line('b1', true), line('b2')], true),
    );
    expect(await deliveries()).toEqual([
      {
        type: 'teaching_package.scene_changed',
        data: {
          versionId: VERSION,
          stageId: STAGE,
          sceneId: 's1',
          change: 'regenerated',
          actorRef: 'agent:42',
        },
      },
      {
        type: 'teaching_package.narration_audio_failed',
        data: { versionId: VERSION, stageId: STAGE, sceneId: 's1', lineIndexes: [2] },
      },
    ]);
  });

  it('a regeneration commit that loses its lease sends nothing', async () => {
    const row = await startRegeneration();
    await expect(
      commitSceneRegeneration(
        tx(),
        { ...commitContext(row), attemptToken: 'not-the-token' },
        narrated('s1', 1, [line('b1', true)]),
      ),
    ).rejects.toMatchObject({ code: 'REGENERATION_LEASE_LOST' });
    expect(await deliveries()).toEqual([]);
  });

  it('a restore sends scene_changed "restored"', async () => {
    const row = await startRegeneration();
    await commitSceneRegeneration(tx(), commitContext(row), narrated('s1', 1, [line('b1', true)]));
    await restoreSceneRegeneration(tx(), {
      regenerationId: row.id,
      tenantId: TENANT,
      actorRef: 'teacher:7',
    });
    const events = await deliveries();
    expect(events.map((event) => [event.type, event.data.change])).toEqual([
      ['teaching_package.scene_changed', 'regenerated'],
      ['teaching_package.scene_changed', 'restored'],
    ]);
    expect(events[1]!.data).toEqual({
      versionId: VERSION,
      stageId: STAGE,
      sceneId: 's1',
      change: 'restored',
      actorRef: 'teacher:7',
    });
  });

  async function startInsertion() {
    const started = await startSceneInsertion(tx(), {
      tenantId: TENANT,
      versionId: VERSION,
      stageId: STAGE,
      newSceneId: 'scene-new',
      newOutlineId: 'ins_new',
      unitIds: ['cu_1'],
      afterSceneId: 's1',
      beforeSceneId: 's2',
      teachingStage: { key: 'explain', flowIndex: 1 },
      idempotencyKey: 'ins-1',
      requestDigest: 'digest',
      instruction: '',
      reason: 'a reason',
      actorRef: 'agent:42',
      sessionRef: null,
      recheck: () => null,
    });
    if (started.kind !== 'started') throw new Error('not started');
    return started.insertion;
  }

  const insertAfterS1 = (doc: AppDocument): AppDocument => ({
    ...doc,
    scenes: [
      ...doc.scenes.map((scene) =>
        scene.order >= 2 ? { ...scene, order: scene.order + 1 } : scene,
      ),
      { ...makeSlideScene('scene-new', STAGE, 2), outlineId: 'ins_new' } as AppScene,
    ],
  });

  it('an insertion commit sends scene_changed "inserted" for the new slide', async () => {
    const insertion = await startInsertion();
    await commitSceneInsertion(
      tx(),
      {
        insertionId: insertion.id,
        attemptToken: insertion.attemptToken,
        tenantId: TENANT,
        versionId: VERSION,
        stageId: STAGE,
        newSceneId: 'scene-new',
        actorRef: 'agent:42',
        reason: 'a reason',
      },
      async (doc) => insertAfterS1(doc),
    );
    expect(await deliveries()).toEqual([
      {
        type: 'teaching_package.scene_changed',
        data: {
          versionId: VERSION,
          stageId: STAGE,
          sceneId: 'scene-new',
          change: 'inserted',
          actorRef: 'agent:42',
        },
      },
    ]);
  });

  it('an insertion that loses its lease sends nothing', async () => {
    const insertion = await startInsertion();
    await expect(
      commitSceneInsertion(
        tx(),
        {
          insertionId: insertion.id,
          attemptToken: 'not-the-token',
          tenantId: TENANT,
          versionId: VERSION,
          stageId: STAGE,
          newSceneId: 'scene-new',
          actorRef: 'agent:42',
          reason: 'a reason',
        },
        async (doc) => insertAfterS1(doc),
      ),
    ).rejects.toMatchObject({ code: 'INSERTION_LEASE_LOST' });
    expect(await deliveries()).toEqual([]);
  });

  const GRANT = { tenantId: TENANT, versionId: VERSION, stageId: STAGE, learnerKey: 'k' };

  /** Voices only the first line that has no audio; the second stays silent. */
  const voiceOne = vi.fn(async (input: { scene: Scene }) => {
    for (const action of input.scene.actions ?? []) {
      const speech = action as SpeechAction;
      if (speech.type === 'speech' && !speech.audioId) {
        speech.audioId = AUDIO(speech.id);
        return { available: true, changed: true, generated: 1, skipped: 0, failed: [] };
      }
    }
    return { available: true, changed: false, generated: 0, skipped: 0, failed: [] };
  });

  it('a narration audio repair sends narration_audio_regenerated, and the line still failing', async () => {
    await store().putScene(STAGE, narrated('s1', 1, [line('c1'), line('c2')], true));
    await regenerateSceneNarrationAudio(GRANT, 's1', {
      pool: tx(),
      actorRef: 'system:package-reviewer',
      synthesize: voiceOne as never,
      loadStage: async () => ({ id: STAGE, name: 'swe', createdAt: 1, updatedAt: 1 }) as AppStage,
    });
    expect(await deliveries()).toEqual([
      {
        type: 'teaching_package.scene_changed',
        data: {
          versionId: VERSION,
          stageId: STAGE,
          sceneId: 's1',
          change: 'narration_audio_regenerated',
          actorRef: 'system:package-reviewer',
        },
      },
      {
        type: 'teaching_package.narration_audio_failed',
        data: { versionId: VERSION, stageId: STAGE, sceneId: 's1', lineIndexes: [2] },
      },
    ]);
  });

  it('a narration audio repair whose provider fails sends nothing', async () => {
    await store().putScene(STAGE, narrated('s1', 1, [line('c1'), line('c2')], true));
    await expect(
      regenerateSceneNarrationAudio(GRANT, 's1', {
        pool: tx(),
        synthesize: (async () => {
          throw new Error('provider down');
        }) as never,
        loadStage: async () => ({ id: STAGE, name: 'swe', createdAt: 1, updatedAt: 1 }) as AppStage,
      }),
    ).rejects.toMatchObject({ code: 'NARRATION_AUDIO_GENERATION_FAILED' });
    expect(await deliveries()).toEqual([]);
  });

  it('generation completion: one narration_audio_failed per marked scene, ids only', async () => {
    await store().putScene(STAGE, narrated('s1', 1, [line('d1'), line('d2', true)], true));
    await enqueueStageNarrationAudioFailures(pool as never, { versionId: VERSION, stageId: STAGE });
    const events = await deliveries();
    expect(events).toEqual([
      {
        type: 'teaching_package.narration_audio_failed',
        data: { versionId: VERSION, stageId: STAGE, sceneId: 's1', lineIndexes: [1] },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('سطر');
  });

  it('lineIndexes count spoken lines only, 1-based, the lines without an audio id', () => {
    expect(
      missingAudioLineIndexes({
        actions: [
          line('e1', true),
          { id: 'x', type: 'spotlight', elementId: 'el' } as never,
          line('e2'),
          { ...line('e3'), text: '' },
          line('e4'),
        ],
      }),
    ).toEqual([2, 3]);
  });
});

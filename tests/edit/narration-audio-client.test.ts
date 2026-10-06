import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave, loadStageData } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue(undefined),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: (...args: unknown[]) => loadStageData(...args),
}));

import {
  hasNarrationAudioIssue,
  runNarrationAudioRegeneration,
} from '@/lib/edit/narration-audio-client';
import { migrateScene } from '@/lib/edit/slide-schema';
import {
  bindStageSceneRevs,
  clearStageSceneRevs,
  sceneRev,
} from '@/lib/persistence/scene-revision-registry';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

/**
 * scene-narration-audio-regeneration-plan C6: lock → drain → hold → POST →
 * apply → release, the slide regeneration discipline. `fetch` is the server.
 */

const STAGE = 'stage-1';
const AUDIO = '/api/classroom-media/stage-1/audio/tts-a1-abc.mp3';
const stage = (): Stage => ({ id: STAGE, name: STAGE, createdAt: 1, updatedAt: 1 });
const quiz = (voiced: boolean, title = 'quiz'): Scene =>
  ({
    id: 'scene-1',
    stageId: STAGE,
    type: 'quiz',
    title,
    order: 1,
    content: { type: 'quiz', questions: [] },
    actions: [
      {
        id: 'a1',
        type: 'speech',
        text: 'نص',
        ...(voiced ? { audioId: AUDIO, audioUrl: AUDIO } : {}),
      },
    ],
    ...(voiced
      ? {}
      : { generationIssues: [{ code: 'NARRATION_AUDIO_FAILED', message: 'no audio' }] }),
  }) as unknown as Scene;

function server(answer: () => Response) {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return answer();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const input = { stageId: STAGE, sceneId: 'scene-1' };
const displayed = () => useStageStore.getState().scenes.find((entry) => entry.id === 'scene-1');

beforeEach(() => {
  incrementalSave.mockReset().mockResolvedValue(undefined);
  loadStageData.mockReset().mockResolvedValue(null);
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stage(),
    scenes: [quiz(false)],
    currentSceneId: 'scene-1',
    chats: [],
  });
  bindStageSceneRevs(STAGE, { 'scene-1': 3 });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  clearStageSceneRevs();
});

describe('runNarrationAudioRegeneration', () => {
  it('POSTs once, then shows the server copy with its revision and no mark', async () => {
    const fake = server(() =>
      Response.json({ sceneId: 'scene-1', scene: quiz(true), rev: 4, generated: 1, missing: 0 }),
    );
    const outcome = await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(outcome).toEqual({ kind: 'success', generated: 1 });
    expect(fake.calls).toEqual([
      { url: '/api/stages/stage-1/scenes/scene-1/narration-audio', method: 'POST' },
    ]);
    expect(displayed()).toEqual(migrateScene(quiz(true)));
    expect(hasNarrationAudioIssue(displayed()!)).toBe(false);
    expect(sceneRev(STAGE, 'scene-1')).toBe(4);
  });

  it('a partial result is applied and reported with the missing count', async () => {
    const fake = server(() =>
      Response.json({ sceneId: 'scene-1', scene: quiz(false), rev: 4, generated: 1, missing: 2 }),
    );
    const outcome = await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(outcome).toEqual({ kind: 'partial', generated: 1, missing: 2 });
    expect(sceneRev(STAGE, 'scene-1')).toBe(4);
  });

  it('a pending edit is saved before the POST', async () => {
    const order: string[] = [];
    incrementalSave.mockImplementation(async () => {
      order.push('save');
    });
    const fake = server(() => {
      order.push('post');
      return Response.json({
        sceneId: 'scene-1',
        scene: quiz(true),
        rev: 4,
        generated: 1,
        missing: 0,
      });
    });
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(order).toEqual(['save', 'post']);
  });

  it('a save that cannot be made first sends no POST', async () => {
    incrementalSave.mockRejectedValue(new Error('offline'));
    const fake = server(() => Response.json({}));
    useStageStore.getState().updateScene('scene-1', { title: 'pending' });
    const outcome = await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(outcome).toEqual({ kind: 'not-durable' });
    expect(fake.calls).toHaveLength(0);
  });

  it('a server error is reported and the displayed scene is unchanged', async () => {
    const before = displayed();
    const fake = server(() =>
      Response.json(
        { error: { code: 'NARRATION_AUDIO_GENERATION_FAILED', message: 'provider down' } },
        { status: 502 },
      ),
    );
    const outcome = await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(outcome).toEqual({
      kind: 'failed',
      status: 502,
      code: 'NARRATION_AUDIO_GENERATION_FAILED',
      message: 'provider down',
    });
    expect(displayed()).toBe(before);
    expect(sceneRev(STAGE, 'scene-1')).toBe(3);
  });

  it('409 SCENE_REVISION_CONFLICT shows what the database holds now', async () => {
    loadStageData.mockResolvedValue({
      stage: stage(),
      scenes: [quiz(false, 'edited elsewhere')],
      currentSceneId: 'scene-1',
      chats: [],
      sceneRevs: { 'scene-1': 5 },
    });
    const fake = server(() =>
      Response.json(
        { error: { code: 'SCENE_REVISION_CONFLICT', message: 'changed' } },
        { status: 409 },
      ),
    );
    const outcome = await runNarrationAudioRegeneration(input, { fetchImpl: fake.fetchImpl });
    expect(outcome).toMatchObject({ kind: 'failed', code: 'SCENE_REVISION_CONFLICT' });
    expect(displayed()?.title).toBe('edited elsewhere');
  });
});

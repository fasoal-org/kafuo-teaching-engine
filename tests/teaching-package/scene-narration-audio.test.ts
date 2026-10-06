import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppStage } from '@/lib/document-store/persistence-types';
import {
  buildSceneAlignmentBaseline,
  deriveSceneAlignment,
} from '@/lib/server/teaching-package/alignment';
import { issuesAfterAudioRepair } from '@/lib/server/teaching-package/narration-audio-issue';
import {
  regenerateSceneNarrationAudio,
  type NarrationAudioDeps,
} from '@/lib/server/teaching-package/scene-narration-audio';
import type { SpeechAction } from '@/lib/types/action';
import type { AppScene, Scene } from '@/lib/types/stage';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const versionState = { status: 'draft' as string };
vi.mock('@/lib/persistence/teaching-package', () => ({
  readVersionById: vi.fn(async () => ({
    id: 'tpv-1',
    tenantId: 't-1',
    currentStageId: 'stage-1',
    status: versionState.status,
  })),
}));

const storeState: { live: { scene: AppScene; rev: number } | null; running: string[] } = {
  live: null,
  running: [],
};
vi.mock('@/lib/server/teaching-package/scene-regeneration-store', () => ({
  readLiveScene: vi.fn(async () => storeState.live),
  listRunningSceneRegenerations: vi.fn(async () =>
    storeState.running.map((sceneId) => ({ sceneId, regenerationId: `tsr-${sceneId}` })),
  ),
}));

/**
 * scene-narration-audio-regeneration-plan §4: the reviewer's audio repair of
 * one Scene. Synthesis, the Stage read and the fenced write are seams; the
 * version / running-regeneration / live-Scene reads are module mocks.
 */

const GRANT = { tenantId: 't-1', versionId: 'tpv-1', stageId: 'stage-1', learnerKey: 'k' };
const AUDIO_ISSUE = {
  code: 'NARRATION_AUDIO_FAILED',
  message:
    'narration audio could not be generated for 1 of 1 spoken line(s); students will not hear the teacher voice there',
};
const stage = {
  id: 'stage-1',
  name: 'قصة مادتين',
  language: 'ar',
  subjectCode: 'CHEMISTRY',
  createdAt: 1,
  updatedAt: 1,
} as unknown as AppStage;

function quiz(actions: unknown[], extra: Record<string, unknown> = {}): AppScene {
  const scene = {
    id: 'scene-q',
    stageId: 'stage-1',
    outlineId: 'scene_8',
    order: 8,
    title: 'تحقق من فهم تطور CFCs',
    type: 'quiz',
    createdAt: 1,
    updatedAt: 1,
    content: {
      type: 'quiz',
      questions: [{ id: 'q1', type: 'short_answer', question: 'اشرح', hasAnswer: false }],
    },
    actions,
    teachingSkills: {
      primary: { skillId: 'feynman-learning', version: 'v1' },
      classification: 'instructional',
    },
    generationIssues: [AUDIO_ISSUE],
    ...extra,
  } as unknown as AppScene;
  const baseline = buildSceneAlignmentBaseline(scene, { origin: 'generation', now: 5 });
  return { ...scene, alignmentBaseline: baseline! };
}

const line = (id: string, audio?: string) => ({
  id,
  type: 'speech',
  text: `جملة ${id}`,
  ...(audio ? { audioId: audio, audioUrl: audio } : {}),
});

/** Voices the first `count` lines without audio (all when undefined). */
function synthesizer(count?: number) {
  return vi.fn(async (input: { scene: Scene }) => {
    let generated = 0;
    for (const action of input.scene.actions ?? []) {
      const speech = action as SpeechAction & { audioUrl?: string };
      if (speech.type !== 'speech' || speech.audioId) continue;
      if (count !== undefined && generated >= count) continue;
      const ref = `/api/classroom-media/stage-1/audio/tts-${speech.id}-abc.mp3`;
      speech.audioId = ref;
      speech.audioUrl = ref;
      speech.audioProvenance = {
        fingerprint: 'fp1:x',
        policyVersion: null,
        originalDigest: 'd',
        responseFormat: 'mp3',
        providerId: 'cartesia-tts',
        modelId: 'sonic-3.6',
        voice: 'reem',
        speed: 1,
        preparedDigest: 'd',
        segments: 1,
        preparedChars: 5,
        originalChars: 5,
        warningCount: 0,
        generatedAt: '2026-10-04T00:00:00.000Z',
        reason: 'initial',
      };
      generated += 1;
    }
    return { available: true, changed: generated > 0, generated, skipped: 0, failed: [] };
  });
}

function deps(overrides: Partial<NarrationAudioDeps> = {}) {
  const writes: Array<{ target: { baseRev: number }; scene: AppScene }> = [];
  const value: NarrationAudioDeps = {
    pool: {} as ConnectableQueryable,
    now: () => 99,
    loadStage: async () => stage,
    writeScene: async (_pool, target, scene) => {
      writes.push({ target, scene });
      return target.baseRev + 1;
    },
    ...overrides,
  };
  return { value, writes };
}

beforeEach(() => {
  versionState.status = 'draft';
  storeState.running = [];
  storeState.live = null;
});

describe('regenerateSceneNarrationAudio', () => {
  it('voices the missing line with the package storage rule, removes the mark and keeps the scene aligned', async () => {
    const pre = quiz([{ ...line('a1'), audioInvalidated: true }]);
    storeState.live = { scene: pre, rev: 7 };
    const synthesize = synthesizer();
    const { value, writes } = deps({ synthesize });

    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]![0]).toMatchObject({
      force: false,
      persist: { kind: 'audio-dir' },
      transientAttempts: 2,
      entry: 'batch',
      stage: { subjectCode: 'CHEMISTRY', language: 'ar' },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.target).toMatchObject({ stageId: 'stage-1', sceneId: 'scene-q', baseRev: 7 });
    expect(result).toMatchObject({ generated: 1, missing: 0, rev: 8 });
    const speech = result.scene.actions![0] as SpeechAction & { audioUrl?: string };
    expect(speech.audioId).toBe('/api/classroom-media/stage-1/audio/tts-a1-abc.mp3');
    expect(speech.audioUrl).toBe(speech.audioId);
    expect(speech.audioInvalidated).toBeUndefined();
    expect(result.scene.generationIssues).toBeUndefined();
    // Text and content untouched; the live scene object was never mutated.
    expect(speech.text).toBe('جملة a1');
    expect(result.scene.content).toEqual(pre.content);
    expect((pre.actions![0] as SpeechAction).audioId).toBeUndefined();
    // Only audio changed: the generation baseline is carried forward.
    expect(deriveSceneAlignment(result.scene)).toMatchObject({ state: 'current', aligned: true });
    expect(result.scene.alignmentBaseline).toMatchObject({
      origin: 'generation',
      establishedAt: 5,
    });
  });

  it('a partial result is saved and the mark keeps the new count', async () => {
    storeState.live = {
      scene: quiz([line('a1'), line('a2'), line('a3', '/api/classroom-media/stage-1/audio/x.mp3')]),
      rev: 3,
    };
    const { value, writes } = deps({ synthesize: synthesizer(1) });
    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);
    expect(writes).toHaveLength(1);
    expect(result).toMatchObject({ generated: 1, missing: 1 });
    expect(result.scene.generationIssues).toEqual([
      {
        code: 'NARRATION_AUDIO_FAILED',
        message:
          'narration audio could not be generated for 1 of 3 spoken line(s); students will not hear the teacher voice there',
      },
    ]);
  });

  it('keeps the other issues of the scene', async () => {
    const other = { code: 'SPEECH_REGISTER_NONCOMPLIANT', message: 'register' };
    storeState.live = {
      scene: quiz([line('a1')], { generationIssues: [other, AUDIO_ISSUE] }),
      rev: 1,
    };
    const { value } = deps({ synthesize: synthesizer() });
    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);
    expect(result.scene.generationIssues).toEqual([other]);
  });

  it('nothing voiced → NARRATION_AUDIO_GENERATION_FAILED and nothing written', async () => {
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    const { value, writes } = deps({ synthesize: synthesizer(0) });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'NARRATION_AUDIO_GENERATION_FAILED',
      status: 502,
    });
    expect(writes).toHaveLength(0);
  });

  it('a provider error → NARRATION_AUDIO_GENERATION_FAILED and nothing written', async () => {
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    const synthesize = vi.fn(async () => {
      throw new Error('timeout');
    });
    const { value, writes } = deps({ synthesize });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'NARRATION_AUDIO_GENERATION_FAILED',
    });
    expect(writes).toHaveLength(0);
  });

  it('an unavailable subject route → NARRATION_AUDIO_UNAVAILABLE and nothing written', async () => {
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    const synthesize = vi.fn(async () => ({
      available: false,
      changed: false,
      generated: 0,
      skipped: 0,
      failed: [],
    }));
    const { value, writes } = deps({ synthesize });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'NARRATION_AUDIO_UNAVAILABLE',
      status: 503,
    });
    expect(writes).toHaveLength(0);
  });

  it('refuses while a regeneration of the same scene is running, before any synthesis', async () => {
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    storeState.running = ['scene-q'];
    const synthesize = synthesizer();
    const { value } = deps({ synthesize });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'SCENE_REGENERATION_IN_PROGRESS',
    });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('refuses a version that is not editable, before any synthesis', async () => {
    versionState.status = 'approved';
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    const synthesize = synthesizer();
    const { value } = deps({ synthesize });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'STAGE_LOCKED',
    });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('an unknown scene → SCENE_NOT_FOUND', async () => {
    const { value } = deps({ synthesize: synthesizer() });
    await expect(regenerateSceneNarrationAudio(GRANT, 'nope', value)).rejects.toMatchObject({
      code: 'SCENE_NOT_FOUND',
    });
  });

  it('a revision conflict at the write surfaces as-is', async () => {
    storeState.live = { scene: quiz([line('a1')]), rev: 1 };
    const { TeachingPackageError } = await import('@/lib/server/teaching-package/errors');
    const { value } = deps({
      synthesize: synthesizer(),
      writeScene: async () => {
        throw new TeachingPackageError('SCENE_REVISION_CONFLICT', 'changed elsewhere');
      },
    });
    await expect(regenerateSceneNarrationAudio(GRANT, 'scene-q', value)).rejects.toMatchObject({
      code: 'SCENE_REVISION_CONFLICT',
      status: 409,
    });
  });

  it('a scene already stale stays stale (its baseline is never carried forward)', async () => {
    const aligned = quiz([line('a1')]);
    const edited = { ...aligned, title: 'عنوان عدّله المراجع' } as AppScene;
    expect(deriveSceneAlignment(edited).aligned).toBe(false);
    storeState.live = { scene: edited, rev: 1 };
    const { value } = deps({ synthesize: synthesizer() });
    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);
    expect(result.scene.alignmentBaseline).toEqual(aligned.alignmentBaseline);
    expect(deriveSceneAlignment(result.scene)).toMatchObject({ state: 'stale' });
  });

  it('every line already voiced and the mark still present → only the mark is removed', async () => {
    storeState.live = {
      scene: quiz([line('a1', '/api/classroom-media/stage-1/audio/x.mp3')]),
      rev: 4,
    };
    const { value, writes } = deps({ synthesize: synthesizer() });
    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);
    expect(writes).toHaveLength(1);
    expect(result).toMatchObject({ generated: 0, missing: 0 });
    expect(result.scene.generationIssues).toBeUndefined();
  });

  it('nothing missing and no mark → nothing written', async () => {
    storeState.live = {
      scene: quiz([line('a1', '/api/classroom-media/stage-1/audio/x.mp3')], {
        generationIssues: undefined,
      }),
      rev: 4,
    };
    const { value, writes } = deps({ synthesize: synthesizer() });
    const result = await regenerateSceneNarrationAudio(GRANT, 'scene-q', value);
    expect(writes).toHaveLength(0);
    expect(result.rev).toBe(4);
  });
});

describe('issuesAfterAudioRepair', () => {
  it('removes the audio mark when nothing is missing and drops an empty list', () => {
    expect(issuesAfterAudioRepair([AUDIO_ISSUE], { spoken: 2, missing: 0 })).toBeUndefined();
  });
});

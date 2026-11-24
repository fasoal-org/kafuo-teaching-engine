/**
 * Owner, 25 Nov 2026: a regenerated (or AI-inserted) slide of a voiced lesson is voiced
 * before it is saved, so it no longer comes back under the red "audio missing" card. Any
 * failure keeps the slide exactly as before, marked, with its "Regenerate audio" button.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildSceneAlignmentBaseline,
  deriveSceneAlignment,
} from '@/lib/server/teaching-package/alignment';
import { voiceRegeneratedScene } from '@/lib/server/teaching-package/regenerated-scene-voice';
import type { AppScene } from '@/lib/types/stage';

const MARK = {
  code: 'NARRATION_AUDIO_FAILED',
  message: 'narration audio could not be generated for 2 of 2 spoken line(s)',
};
const OTHER = { code: 'SPEECH_REGISTER_NONCOMPLIANT', message: 'register' };

function scene(issues: Array<{ code: string; message: string }>): AppScene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'شريحة',
    order: 1,
    content: { type: 'slide', canvas: { elements: [] } },
    actions: [
      { id: 'a1', type: 'speech', text: 'السطر الأول' },
      { id: 'a2', type: 'speech', text: 'السطر الثاني' },
    ],
    ...(issues.length > 0 ? { generationIssues: issues } : {}),
  } as unknown as AppScene;
}

const STAGE = { subjectCode: 'PHYSICS', language: 'ar' } as never;

/** A synthesis that voices the given action ids of the scene it is handed. */
function voicing(ids: string[], available = true) {
  return vi.fn(async (input: { scene: { actions: Array<Record<string, unknown>> } }) => {
    for (const action of input.scene.actions) {
      if (ids.includes(String(action.id))) action.audioId = `audio-${String(action.id)}`;
    }
    return { available, changed: ids.length > 0, generated: ids.length, skipped: 0, failed: [] };
  });
}

describe('voiceRegeneratedScene', () => {
  it('voices every line and drops the audio mark, keeping other issues', async () => {
    const synthesize = voicing(['a1', 'a2']);
    const voiced = await voiceRegeneratedScene(scene([OTHER, MARK]), STAGE, {
      synthesize: synthesize as never,
    });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize.mock.calls[0]![0]).toMatchObject({
      force: false,
      persist: { kind: 'audio-dir' },
      transientAttempts: 2,
      entry: 'batch',
    });
    expect(voiced.generationIssues).toEqual([OTHER]);
    expect((voiced.actions as Array<{ audioId?: string }>).map((a) => a.audioId)).toEqual([
      'audio-a1',
      'audio-a2',
    ]);
  });

  it('a slide with every line voiced loses the mark entirely', async () => {
    const voiced = await voiceRegeneratedScene(scene([MARK]), STAGE, {
      synthesize: voicing(['a1', 'a2']) as never,
    });
    expect(voiced).not.toHaveProperty('generationIssues');
  });

  it('a line still unvoiced keeps the mark, counted again', async () => {
    const voiced = await voiceRegeneratedScene(scene([MARK]), STAGE, {
      synthesize: voicing(['a1']) as never,
    });
    expect(voiced.generationIssues).toHaveLength(1);
    expect(voiced.generationIssues![0]!.message).toContain('1 of 2');
  });

  it('never calls the voice for a slide without the mark (an unvoiced lesson)', async () => {
    const synthesize = voicing(['a1', 'a2']);
    const unmarked = scene([OTHER]);
    expect(await voiceRegeneratedScene(unmarked, STAGE, { synthesize: synthesize as never })).toBe(
      unmarked,
    );
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('keeps the slide exactly as it was when the voice fails or is unavailable', async () => {
    const marked = scene([MARK]);
    const thrown = vi.fn(async () => {
      throw new Error('provider down');
    });
    expect(await voiceRegeneratedScene(marked, STAGE, { synthesize: thrown as never })).toBe(
      marked,
    );
    expect(
      await voiceRegeneratedScene(marked, STAGE, {
        synthesize: voicing(['a1', 'a2'], false) as never,
      }),
    ).toBe(marked);
    expect(await voiceRegeneratedScene(marked, STAGE, { synthesize: voicing([]) as never })).toBe(
      marked,
    );
    // The candidate itself is never touched by a failed or partial run.
    expect((marked.actions as Array<{ audioId?: string }>).every((a) => !a.audioId)).toBe(true);
  });

  // Review B (25 Nov 2026) findings, each pinned.
  it('HIGH: the generation baseline is carried over the audio, so the slide is not stale at Submit', async () => {
    const governed = {
      ...scene([MARK]),
      teachingSkills: { classification: 'instructional' },
    } as unknown as AppScene;
    const aligned = {
      ...governed,
      alignmentBaseline: buildSceneAlignmentBaseline(governed, { origin: 'generation', now: 1 })!,
    } as AppScene;
    expect(deriveSceneAlignment(aligned).aligned).toBe(true);
    const voiced = await voiceRegeneratedScene(aligned, STAGE, {
      synthesize: voicing(['a1', 'a2']) as never,
    });
    expect((voiced.actions as Array<{ audioId?: string }>)[0]!.audioId).toBe('audio-a1');
    expect(deriveSceneAlignment(voiced).aligned).toBe(true);
  });

  it('MEDIUM: the voice stops at its deadline and the slide keeps its mark', async () => {
    const marked = scene([MARK]);
    // No time left: the provider is never called.
    const never = voicing(['a1', 'a2']);
    expect(
      await voiceRegeneratedScene(marked, STAGE, {
        synthesize: never as never,
        deadlineMs: 1_000,
        now: () => 2_000,
      }),
    ).toBe(marked);
    expect(never).not.toHaveBeenCalled();
    // A provider still running at the deadline: aborted, the slide kept as it was.
    const hung = vi.fn(
      (input: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          input.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const start = Date.now();
    expect(
      await voiceRegeneratedScene(marked, STAGE, {
        synthesize: hung as never,
        deadlineMs: start + 20,
      }),
    ).toBe(marked);
  });

  it('LOW: an evicted reviewer run stops as ABORTED, never saved unvoiced', async () => {
    const evicted = new AbortController();
    evicted.abort();
    const thrown = vi.fn(async () => {
      throw new Error('aborted');
    });
    await expect(
      voiceRegeneratedScene(scene([MARK]), STAGE, {
        synthesize: thrown as never,
        signal: evicted.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

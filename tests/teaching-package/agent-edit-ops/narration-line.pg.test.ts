/**
 * Wave F2.2 over PGlite, through the real `agent-ops/narration-line` route: one speech
 * line addressed by its ACTION id gets the new text (not pre-normalized), loses its audio,
 * and only that line is voiced again with the Stage's TTS route (stubbed here: the
 * provider). The register check refuses a line the policy would refuse in generation;
 * a TTS failure keeps the text and reports the audio's code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { body, setupHarness, textSlide, type Harness } from './_pg';

const tts = vi.hoisted(() => ({ fail: false, calls: [] as string[][] }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/server/agent-runtime/scene-tts', () => ({
  synthesizeSceneNarration: async (input: {
    scene: { actions?: Array<Record<string, unknown>> };
    force: boolean;
  }) => {
    if (tts.fail) throw new Error('provider down');
    const voiced: string[] = [];
    for (const action of input.scene.actions ?? []) {
      if (action.type === 'speech' && !action.audioId) {
        action.audioId = `aud-new-${String(action.id)}`;
        voiced.push(String(action.id));
      }
    }
    tts.calls.push(voiced);
    return { available: true, generated: voiced.length };
  },
}));

describe('agent-ops narration-line', () => {
  let harness: Harness;

  beforeEach(() => {
    tts.fail = false;
    tts.calls.length = 0;
  });

  afterEach(async () => {
    await harness.pool.end();
    vi.unstubAllEnvs();
  });

  it('sets the line by action id, clears its audio and voices only that line', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const newText = 'طيب الحين نشوف 3/4 من الكعكة';
    const response = await harness.post('narration-line', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      actionId: 'scene-1-speech-2',
      text: newText,
      idempotencyKey: 'agt_3_line_000000001',
    });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer).toMatchObject({
      status: 'done',
      actionId: 'scene-1-speech-2',
      text: newText,
      audio: { status: 'done', generated: 1, missing: 0 },
    });
    expect(tts.calls).toEqual([['scene-1-speech-2']]);
    const actions = (await harness.scene('scene-1')).actions as unknown as Array<
      Record<string, unknown>
    >;
    expect(actions[0]).toMatchObject({ text: 'طيب خلونا نشوف هذي الفكرة', audioId: 'aud-1' });
    // Stored as sent: the reading mode is applied at synthesis, never here.
    expect(actions[1]).toMatchObject({ text: newText, audioId: 'aud-new-scene-1-speech-2' });
    expect(actions[1]).not.toHaveProperty('audioInvalidated');

    // The read addresses lines by the same action id.
    const read = await harness.read();
    const lines = (read.scenes[0]!.narration as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines.map((line) => line.action_id)).toEqual(['scene-1-speech-1', 'scene-1-speech-2']);
  });

  it('A8 after the real two writes (text, then TTS): the slide stays confirmable (R-H1)', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)], governed: true });
    const response = await harness.post('narration-line', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      actionId: 'scene-1-speech-2',
      text: 'طيب الحين نكمل الفكرة',
    });
    expect((await body(response)).audio).toMatchObject({ status: 'done', generated: 1 });
    const read = await harness.read();
    expect(read.scenes[0]!.alignment).toEqual({
      state: 'stale',
      reason: 'material-change',
      confirmable_by_agent: true,
    });
    const confirmed = await harness.post('alignment-confirm', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      reason: 'the agent rewrote one narration line',
    });
    expect(confirmed.status).toBe(200);
    expect(await body(confirmed)).toMatchObject({ status: 'done', proof: 'edit' });
  });

  it('a TTS failure keeps the new text; the line reads missing and the code is reported', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    tts.fail = true;
    const response = await harness.post('narration-line', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      actionId: 'scene-1-speech-1',
      text: 'طيب خلونا نبدأ',
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      status: 'done',
      audio: { status: 'failed', errorCode: 'NARRATION_AUDIO_GENERATION_FAILED' },
    });
    const actions = (await harness.scene('scene-1')).actions as unknown as Array<
      Record<string, unknown>
    >;
    expect(actions[0]).toMatchObject({ text: 'طيب خلونا نبدأ', audioInvalidated: true });
    expect(actions[0]).not.toHaveProperty('audioId');
  });

  it('refuses a line the register policy refuses, an unknown action and a dry run writes nothing', async () => {
    harness = await setupHarness({
      scenes: [textSlide('scene-1', 1)],
      governed: true,
      subjectCode: 'MATH',
    });
    const revision = await harness.revision();
    const latin = await harness.post('narration-line', {
      expectedRevision: revision,
      sceneId: 'scene-1',
      actionId: 'scene-1-speech-1',
      text: 'طيب hello world خلونا',
    });
    expect(latin.status).toBe(422);
    const refusal = await body(latin);
    expect(refusal.error.code).toBe('SPEECH_REGISTER_NONCOMPLIANT');
    expect(refusal.error.details.issues[0].code).toBe('LATIN_SCRIPT');

    const missing = await harness.post('narration-line', {
      expectedRevision: revision,
      sceneId: 'scene-1',
      actionId: 'nope',
      text: 'طيب',
    });
    expect(missing.status).toBe(404);
    expect((await body(missing)).error.code).toBe('NARRATION_LINE_NOT_FOUND');

    const dry = await harness.post('narration-line', {
      expectedRevision: revision,
      dryRun: true,
      sceneId: 'scene-1',
      actionId: 'scene-1-speech-1',
      text: 'طيب خلونا نبدأ',
    });
    expect(await body(dry)).toMatchObject({ dryRun: true, status: 'would_update' });
    expect(await harness.revision()).toBe(revision);
    expect(tts.calls).toEqual([]);
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
  });
});

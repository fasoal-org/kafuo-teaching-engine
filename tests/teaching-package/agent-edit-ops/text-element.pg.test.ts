/**
 * Wave F2.3 over PGlite, through the real `agent-ops/text-element` route: one text
 * element's text, under the revision precondition, with its agent op row (A8 proof),
 * its webhook, the sacred guard, a dry run that writes nothing and a keyed replay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT, body, setupHarness, STAGE, textSlide, type Harness } from './_pg';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** A hook run once, after a call read the live scene and before it writes: the race. */
const race = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock('@/lib/server/teaching-package/agent-alignment-proof', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/teaching-package/agent-alignment-proof')>();
  return {
    ...actual,
    loadSceneWriteEvents: async (...args: Parameters<typeof actual.loadSceneWriteEvents>) => {
      const before = race.before;
      race.before = null;
      if (before) await before();
      return actual.loadSceneWriteEvents(...args);
    },
  };
});

const KEY = 'agt_3_text0123456789abcdef0123456789';

describe('agent-ops text-element', () => {
  let harness: Harness;

  afterEach(async () => {
    race.before = null;
    await harness.pool.end();
    vi.unstubAllEnvs();
  });

  it('two calls racing on one key: the loser answers the winner’s row as its replay (L8)', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const request = {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'النص الجديد',
      idempotencyKey: KEY,
    };
    let winner: Record<string, unknown> | null = null;
    // The winner lands after the loser read the scene (and found no row of the key).
    race.before = async () => {
      winner = await body(await harness.post('text-element', request));
    };
    const loser = await harness.post('text-element', request);
    expect(winner).toMatchObject({ status: 'done', replayed: false });
    expect(loser.status).toBe(200);
    expect(await body(loser)).toMatchObject({
      status: 'done',
      replayed: true,
      sceneId: 'scene-1',
      resultSceneRev: winner!.resultSceneRev,
    });
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(1);
  });

  it('a race lost to another body (or no key) stays 409 SCENE_REVISION_CONFLICT', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const request = {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'النص الجديد',
      idempotencyKey: KEY,
    };
    race.before = async () => {
      await harness.post('text-element', { ...request, text: 'نص الفائز' });
    };
    const reused = await harness.post('text-element', request);
    expect(reused.status).toBe(409);
    expect((await body(reused)).error.code).toBe('SCENE_REVISION_CONFLICT');

    const revision = await harness.revision();
    race.before = async () => {
      await harness.post('text-element', {
        ...request,
        expectedRevision: revision,
        idempotencyKey: undefined,
        text: 'نص ثالث',
      });
    };
    const unkeyed = await harness.post('text-element', {
      ...request,
      expectedRevision: revision,
      idempotencyKey: undefined,
    });
    expect(unkeyed.status).toBe(409);
    expect((await body(unkeyed)).error.code).toBe('SCENE_REVISION_CONFLICT');
  });

  it('normalizes digits on a learner-first package, as the quiz edits do (L10)', async () => {
    harness = await setupHarness({
      scenes: [textSlide('scene-1', 1), textSlide('scene-2', 2, 'نجمع 12 و 34 ثم 56')],
      teachingModel: { key: 'g5', version: 'g5.v10' },
    });
    const response = await harness.post('text-element', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'نعد من ٢ إلى ٤',
    });
    expect(response.status).toBe(200);
    const element = (
      (await harness.scene('scene-1')).content as unknown as {
        canvas: { elements: Array<Record<string, unknown>> };
      }
    ).canvas.elements[0]!;
    // The package's other learner text is Western digits: the new text follows it.
    expect(element.content).toBe('<p>نعد من 2 إلى 4</p>');
  });

  it('keeps the text as sent on a package that is not learner-first', async () => {
    harness = await setupHarness({
      scenes: [textSlide('scene-1', 1), textSlide('scene-2', 2, 'نجمع 12 و 34 ثم 56')],
    });
    await harness.post('text-element', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'نعد من ٢ إلى ٤',
    });
    const element = (
      (await harness.scene('scene-1')).content as unknown as {
        canvas: { elements: Array<Record<string, unknown>> };
      }
    ).canvas.elements[0]!;
    expect(element.content).toBe('<p>نعد من ٢ إلى ٤</p>');
  });

  it('sets one text element, records the op row and the webhook, and replays by key', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const revision = await harness.revision();
    const request = {
      expectedRevision: revision,
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'النص <الجديد>',
      idempotencyKey: KEY,
    };
    const response = await harness.post('text-element', request);
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer).toMatchObject({
      dryRun: false,
      status: 'done',
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
    });
    expect(typeof answer.resultSceneRev).toBe('number');
    const scene = await harness.scene('scene-1');
    const element = (
      scene.content as unknown as { canvas: { elements: Array<Record<string, unknown>> } }
    ).canvas.elements[0]!;
    expect(element.content).toBe('<p>النص &lt;الجديد&gt;</p>');

    const rows = (
      await harness.pool.query(
        `SELECT op, scene_id, actor_ref, result_scene_rev, result_fingerprint, aligned_before
           FROM teaching_package_agent_ops`,
      )
    ).rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: 'text-element',
      scene_id: 'scene-1',
      actor_ref: AGENT,
      aligned_before: false,
    });
    expect(Number(rows[0]!.result_scene_rev)).toBe(answer.resultSceneRev);
    expect(String(rows[0]!.result_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    const webhooks = (
      await harness.pool.query(
        `SELECT payload FROM teaching_package_webhook_deliveries
          WHERE event_type = 'teaching_package.scene_changed'`,
      )
    ).rows;
    expect(JSON.stringify(webhooks)).toContain(AGENT);
    expect(JSON.stringify(webhooks)).toContain('edited');

    // The same key after an unknown outcome: done from the row, before the revision check.
    const retry = await harness.post('text-element', request);
    expect(retry.status).toBe(200);
    expect(await body(retry)).toMatchObject({ status: 'done', replayed: true, sceneId: 'scene-1' });
    const other = await harness.post('text-element', { ...request, text: 'نص آخر' });
    expect(other.status).toBe(409);
    expect((await body(other)).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(1);
  });

  it('a dry run checks and writes nothing; a stale revision is 409 STALE_STATE', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const revision = await harness.revision();
    const dry = await harness.post('text-element', {
      expectedRevision: revision,
      dryRun: true,
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'جديد',
    });
    expect(dry.status).toBe(200);
    expect(await body(dry)).toMatchObject({ dryRun: true, status: 'would_update' });
    expect(await harness.revision()).toBe(revision);
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);

    const stale = await harness.post('text-element', {
      expectedRevision: revision + 5,
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: 'جديد',
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe('STALE_STATE');
  });

  it('refuses a non-text element, an unknown element and a non-slide scene', async () => {
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1)] });
    const revision = await harness.revision();
    const shape = await harness.post('text-element', {
      expectedRevision: revision,
      sceneId: 'scene-1',
      elementId: 'scene-1-shape',
      text: 'x',
    });
    expect(shape.status).toBe(422);
    expect((await body(shape)).error.code).toBe('ELEMENT_NOT_TEXT');
    const missing = await harness.post('text-element', {
      expectedRevision: revision,
      sceneId: 'scene-1',
      elementId: 'nope',
      text: 'x',
    });
    expect(missing.status).toBe(404);
    expect((await body(missing)).error.code).toBe('ELEMENT_NOT_FOUND');
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
  });

  it('the sacred guard refuses an edit that rewrites a pinned verse', async () => {
    const verse = '﴿إِنَّ مَعَ الْعُسْرِ يُسْرًا﴾';
    harness = await setupHarness({ scenes: [textSlide('scene-1', 1, verse)] });
    const { sacredQuotePin } = await import('./_sacred');
    await harness.pool.query(
      `UPDATE document_outlines SET data = jsonb_set(data::jsonb, '{sacredQuotes}', $2::jsonb)
        WHERE stage_id = $1`,
      [STAGE, JSON.stringify([sacredQuotePin(verse)])],
    );
    const refused = await harness.post('text-element', {
      expectedRevision: await harness.revision(),
      sceneId: 'scene-1',
      elementId: 'scene-1-text',
      text: '﴿إِنَّ مَعَ الْعُسْرِ شيئا﴾',
    });
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.code).toBe('SACRED_TEXT_PINNED');
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
  });
});

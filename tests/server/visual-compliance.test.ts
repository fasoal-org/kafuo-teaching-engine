/**
 * RSS Wave 4 — visual compliance (T-01…T-04, T-09, T-15).
 *
 * Only an `approved` verdict makes a visual learner-visible; nothing but a
 * confident vision answer can approve; an unavailable screener FAILS CLOSED;
 * the enforced scope is MOE marks only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MOE_BRAND_PROFILE,
  MemoryVerdictStore,
  isLearnerVisible,
  moeTextSignal,
  screenVisual,
  visualChecksum,
  type VisionScreeningClient,
} from '@/lib/server/visual-compliance';
import { applyComplianceOverlay } from '@/lib/server/visual-compliance/delivery-hold';
import {
  applyImagePromptPolicy,
  resolveImageTextPolicy,
} from '@/lib/server/visual-compliance/prompt-policy';
import { collectStageVisualFindings } from '@/lib/server/visual-compliance/stage-gate';
import { dropUnmappedMediaPlaceholders } from '@/lib/server/classroom-media-generation';

const BYTES = Buffer.from('not-really-a-png');
const vision = (
  answer: Awaited<ReturnType<VisionScreeningClient['screen']>>,
): VisionScreeningClient => ({ model: 'test:vision', screen: vi.fn(async () => answer) });

describe('screenVisual — fail closed, approve only through vision', () => {
  it('is unresolved (not visible) with no vision service, and on a vision outage', async () => {
    const store = new MemoryVerdictStore();
    const none = await screenVisual(BYTES, { origin: 'generated' }, { store });
    expect(none.verdict).toBe('unresolved');
    expect(isLearnerVisible(none)).toBe(false);

    const outage: VisionScreeningClient = {
      model: 'test:vision',
      screen: async () => {
        throw new Error('rate limited');
      },
    };
    const failed = await screenVisual(BYTES, { origin: 'generated' }, { store, vision: outage });
    expect(failed.verdict).toBe('unresolved');
  });

  it('approves only a confident "absent"; low confidence and "uncertain" stay unresolved', async () => {
    const screen = (answer: Parameters<typeof vision>[0]) =>
      screenVisual(
        BYTES,
        { origin: 'generated' },
        { store: new MemoryVerdictStore(), vision: vision(answer) },
      );
    expect((await screen({ moeMark: 'absent', confidence: 0.95 })).verdict).toBe('approved');
    expect((await screen({ moeMark: 'absent', confidence: 0.5 })).verdict).toBe('unresolved');
    expect((await screen({ moeMark: 'uncertain', confidence: 0.99 })).verdict).toBe('unresolved');
    expect((await screen({ moeMark: 'present', confidence: 0.9 })).verdict).toBe('rejected');
  });

  it('enforces MOE marks only: a confidently non-MOE logo is approved', async () => {
    // The vision question is MOE-specific; a company logo answers "absent".
    const verdict = await screenVisual(
      BYTES,
      { origin: 'source', metadata: { caption: 'The company logo used in the case study' } },
      { store: new MemoryVerdictStore(), vision: vision({ moeMark: 'absent', confidence: 0.9 }) },
    );
    expect(verdict.verdict).toBe('approved');
  });

  it('rejects on text that names the MOE mark itself — never on a bare mention or a generic word', () => {
    const profile = DEFAULT_MOE_BRAND_PROFILE;
    expect(moeTextSignal({ caption: 'شعار وزارة التربية والتعليم' }, profile)).toBeDefined();
    expect(moeTextSignal({ caption: 'Ministry of Education logo' }, profile)).toBeDefined();
    expect(moeTextSignal({ description: '© Ministry of Education' }, profile)).toBeDefined();
    expect(moeTextSignal({ caption: 'A school logo' }, profile)).toBeUndefined();
    expect(
      moeTextSignal({ caption: 'Curriculum published by the Ministry of Education' }, profile),
    ).toBeUndefined();
  });

  it('a deterministic layer can reject without vision but can never approve', async () => {
    const store = new MemoryVerdictStore();
    const rejected = await screenVisual(
      BYTES,
      { origin: 'source', metadata: { caption: 'شعار وزارة التعليم' } },
      { store },
    );
    expect(rejected).toMatchObject({ verdict: 'rejected', method: 'text-signal' });
    const excluded = await screenVisual(
      Buffer.from('other'),
      { origin: 'source', metadata: { manifestRole: 'decorative' } },
      { store },
    );
    expect(excluded).toMatchObject({ verdict: 'rejected', method: 'manifest' });
  });

  it('rejects rendered text under the text-free (RTL) policy', async () => {
    const answer = { moeMark: 'absent' as const, confidence: 0.95, containsRenderedText: true };
    const verdict = await screenVisual(
      BYTES,
      { origin: 'generated', textPolicy: 'text-free' },
      { store: new MemoryVerdictStore(), vision: vision(answer) },
    );
    expect(verdict.verdict).toBe('rejected');
    expect(resolveImageTextPolicy('rtl')).toBe('text-free');
    expect(resolveImageTextPolicy(undefined)).toBe('unrestricted');
    expect(applyImagePromptPolicy({ prompt: 'A water cycle' }, 'text-free').prompt).toMatch(
      /Ministry of Education[\s\S]*NO text/,
    );
  });

  it('caches approved/rejected by checksum, never unresolved; an operator verdict outranks automation', async () => {
    const store = new MemoryVerdictStore();
    const client = vision({ moeMark: 'absent', confidence: 0.95 });
    await screenVisual(BYTES, { origin: 'generated' }, { store }); // unresolved
    const resolved = await screenVisual(BYTES, { origin: 'generated' }, { store, vision: client });
    expect(resolved.verdict).toBe('approved'); // the earlier unresolved was not served
    const again = await screenVisual(BYTES, { origin: 'generated' }, { store, vision: client });
    expect(again.method).toBe('cache');
    expect(client.screen).toHaveBeenCalledTimes(1);

    await store.put({
      profileId: DEFAULT_MOE_BRAND_PROFILE.id,
      checksum: visualChecksum(BYTES),
      verdict: 'rejected',
      reasons: ['operator-confirmed'],
      method: 'operator',
      screenedAt: 1,
      confirmedBy: 'ops@example',
    });
    await store.put({ ...resolved, confirmedBy: undefined }); // automation cannot overwrite it
    expect((await screenVisual(BYTES, { origin: 'generated' }, { store })).verdict).toBe(
      'rejected',
    );
  });
});

describe('delivery boundary and gates (T-09, T-15)', () => {
  const held = `data:image/png;base64,${BYTES.toString('base64')}`;
  const fine = `data:image/png;base64,${Buffer.from('fine').toString('base64')}`;
  const scene = (src: string) => ({
    id: 's1',
    type: 'slide',
    content: {
      type: 'slide',
      contentRole: 'practice',
      contentKind: 'independent',
      assistance: { hint: '<p>h</p>' },
      canvas: {
        id: 'c',
        elements: [
          { id: 'img1', type: 'image', src },
          { id: 't', type: 'text', content: '<p>x</p>' },
        ],
      },
    },
  });

  it('the overlay blanks only a held visual, on a copy — stored data and semantics untouched', async () => {
    const store = new MemoryVerdictStore();
    await store.put({
      profileId: DEFAULT_MOE_BRAND_PROFILE.id,
      checksum: visualChecksum(BYTES),
      verdict: 'rejected',
      reasons: ['MOE mark detected'],
      method: 'vision',
      screenedAt: 1,
    });
    const stored = {
      stage: { id: 'st', textDirection: 'rtl' },
      scenes: [scene(held), scene(fine)],
    };
    const snapshot = JSON.stringify(stored);
    const served = await applyComplianceOverlay(stored, store);

    expect(JSON.stringify(stored)).toBe(snapshot);
    expect(served.scenes[0]!.content.canvas.elements[0]!.src).toBe('');
    expect(served.scenes[1]!.content.canvas.elements[0]!.src).toBe(fine);
    expect(served.scenes[0]!.content).toMatchObject({
      contentRole: 'practice',
      contentKind: 'independent',
      assistance: { hint: '<p>h</p>' },
    });
    expect(served.stage).toEqual(stored.stage);
    // Nothing held → the very same object is returned (no rewrite at all).
    const clean = { scenes: [scene(fine)] };
    expect(await applyComplianceOverlay(clean, store)).toBe(clean);
  });

  it('the submit gate blocks an unscreenable or unapproved image, and passes an approved one', async () => {
    const approve = vi.fn(async () => ({ verdict: 'approved' }) as never);
    const withhold = vi.fn(
      async () => ({ verdict: 'unresolved', reasons: ['no vision screening service'] }) as never,
    );
    expect(await collectStageVisualFindings([scene(fine)], { screen: approve })).toEqual([]);
    expect(await collectStageVisualFindings([scene(fine)], { screen: withhold })).toEqual([
      expect.objectContaining({ sceneId: 's1', elementId: 'img1', verdict: 'unresolved' }),
    ]);
    expect(
      await collectStageVisualFindings([scene('https://cdn.example/x.png')], { screen: approve }),
    ).toEqual([expect.objectContaining({ verdict: 'unresolved' })]);
  });

  it('drops an unmapped generated-media placeholder instead of leaving a skeleton', () => {
    const scenes = [scene('gen_img_1'), scene('/api/classroom-media/st/media/ok.png')] as never[];
    const removed = dropUnmappedMediaPlaceholders(scenes);
    expect([...removed.values()]).toEqual([['gen_img_1']]);
    const elements = (scenes[0] as ReturnType<typeof scene>).content.canvas.elements;
    expect(elements.map((element) => element.id)).toEqual(['t']);
  });
});

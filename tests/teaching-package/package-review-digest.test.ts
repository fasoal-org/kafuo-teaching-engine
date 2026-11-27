/**
 * Review of ef78fd7a/4bc87796 (MEDIUM-A, the reviewer's PGlite probe made a test): JSONB
 * reorders object keys on every read, so a slide's digests must not depend on key order.
 * Written, read back, and voiced in memory (the way scene TTS appends its audio fields),
 * one slide gives one digest -- per slide (`sceneEditDigest`) and for the whole
 * review input (`reviewInputDigest`, A-34b). Since the review of 7d7dddc6 the slide digest
 * is the edit rule: any change but geometry and narration audio.
 */
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  sceneEditDigest,
  reviewInputDigest,
} from '@/lib/server/teaching-package/package-review-input';
import type { AppScene } from '@/lib/types/stage';

describe('a slide digest is blind to key order', () => {
  it('written, read back from JSONB, and voiced in memory: one digest', async () => {
    const stored = {
      id: 's2',
      order: 2,
      title: 'شريحة',
      content: { type: 'slide', canvas: { elements: [{ id: 'e', type: 'text', content: 'ب' }] } },
      actions: [{ id: 'a', text: 'شرح', type: 'speech', voice: 'v1' }],
    };
    const db = new PGlite();
    await db.query('CREATE TABLE s (data JSONB NOT NULL)');
    await db.query('INSERT INTO s VALUES ($1::jsonb)', [JSON.stringify(stored)]);
    const live = (await db.query<{ data: AppScene }>('SELECT data FROM s')).rows[0]!.data;
    // Voiced in memory, the way scene TTS appends its fields to the live read.
    const voiced = structuredClone(live);
    const speech = (voiced.actions as unknown as Array<Record<string, unknown>>)[0]!;
    speech.audioId = 'asset-1';
    speech.audioUrl = 'asset-1';
    speech.audioProvenance = {
      fingerprint: 'fp1:x',
      policyVersion: null,
      policyStatus: 'approved',
      originalDigest: 'd',
      responseFormat: 'mp3',
    };
    // What the store holds after the audio write, read back.
    await db.query('UPDATE s SET data = $1::jsonb', [JSON.stringify(voiced)]);
    const reread = (await db.query<{ data: AppScene }>('SELECT data FROM s')).rows[0]!.data;
    await db.close();
    // The written slide and its read-back agree; so do the voiced slide and its read-back.
    expect(sceneEditDigest(live)).toBe(sceneEditDigest(stored as unknown as AppScene));
    expect(sceneEditDigest(voiced)).toBe(sceneEditDigest(reread));
    expect(reviewInputDigest([voiced])).toBe(reviewInputDigest([reread]));
    // Audio is not what the reviewer reads: the voiced slide's review input is the live one.
    expect(reviewInputDigest([voiced])).toBe(reviewInputDigest([live]));
    // Review of 7d7dddc6: nor is voicing a slide an edit of it.
    expect(sceneEditDigest(voiced)).toBe(sceneEditDigest(live));
  });

  it('review of 7d7dddc6: geometry is no edit, inside a group too; content and voice are', () => {
    const scene = (at: number, text: string, voice = 'v1') =>
      ({
        id: 's',
        title: 't',
        content: {
          type: 'slide',
          canvas: {
            elements: [
              {
                id: 'g',
                type: 'group',
                left: at,
                top: at,
                width: 300,
                height: 100,
                rotate: 0,
                elements: [
                  {
                    id: 'c',
                    type: 'text',
                    content: text,
                    left: at + 4,
                    top: 2,
                    width: 90,
                    height: 40,
                  },
                ],
              },
            ],
          },
        },
        actions: [{ id: 'a', type: 'speech', text: 'شرح', voice, speed: 1 }],
      }) as unknown as AppScene;
    expect(sceneEditDigest(scene(5, '<p>H<sub>2</sub>O</p>'))).toBe(
      sceneEditDigest(scene(60, '<p>H<sub>2</sub>O</p>')),
    );
    expect(sceneEditDigest(scene(5, '<p>H<sub>2</sub>O</p>'))).not.toBe(
      sceneEditDigest(scene(5, '<p>H<sup>2</sup>O</p>')),
    );
    expect(sceneEditDigest(scene(5, 'أ'))).not.toBe(sceneEditDigest(scene(5, 'أ', 'v2')));
  });

  it('canonical JSON sorts every object’s keys, keeps array order, drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":0,"z":1}]},"b":1}',
    );
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

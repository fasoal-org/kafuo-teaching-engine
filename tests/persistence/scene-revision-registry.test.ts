import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applySceneRevsResult,
  bindStageSceneRevs,
  clearStageSceneRevs,
  coveredDocumentWrite,
  expectedSceneRevsHeader,
  revisionAwareFetch,
  sceneRev,
  setSceneRev,
  stageSceneRevs,
} from '@/lib/persistence/scene-revision-registry';

/** single-slide-regeneration-plan §11.2–§11.3: the browser revision registry. */

const decode = (header: string | undefined) =>
  header === undefined ? undefined : JSON.parse(decodeURIComponent(header));

afterEach(() => clearStageSceneRevs());

describe('scene revision registry', () => {
  it('covers exactly the Scene-replacing document writes', () => {
    expect(coveredDocumentWrite('PUT', '/documents/s1')).toEqual({
      kind: 'document',
      stageId: 's1',
    });
    expect(coveredDocumentWrite('PUT', '/api/persistence/documents/s1/scenes/a%20b')).toEqual({
      kind: 'scene',
      stageId: 's1',
      sceneId: 'a b',
      method: 'PUT',
    });
    expect(coveredDocumentWrite('DELETE', '/documents/s1/scenes/x')).toMatchObject({
      method: 'DELETE',
    });
    expect(coveredDocumentWrite('PUT', '/documents/s1/stage')).toBeNull();
    expect(coveredDocumentWrite('GET', '/documents/s1')).toBeNull();
    expect(coveredDocumentWrite('DELETE', '/documents/s1')).toBeNull();
  });

  it('adds nothing for a Stage it never bound (non-grant writes stay byte-identical)', () => {
    expect(expectedSceneRevsHeader('PUT', '/documents/s1/scenes/x')).toBeUndefined();
    expect(expectedSceneRevsHeader('PUT', '/documents/s1')).toBeUndefined();
  });

  it('sends the scene’s own revision for a scene write, and every entry for a whole save', () => {
    bindStageSceneRevs('s1', { a: 3, b: 5 });
    expect(decode(expectedSceneRevsHeader('PUT', '/documents/s1/scenes/a'))).toEqual({ a: 3 });
    expect(decode(expectedSceneRevsHeader('DELETE', '/documents/s1/scenes/b'))).toEqual({ b: 5 });
    // A locally created scene has no entry: a creation.
    expect(decode(expectedSceneRevsHeader('PUT', '/documents/s1/scenes/new'))).toEqual({});
    expect(decode(expectedSceneRevsHeader('PUT', '/documents/s1'))).toEqual({ a: 3, b: 5 });
    expect(expectedSceneRevsHeader('PUT', '/documents/s1/stage')).toBeUndefined();
  });

  it('learns result revisions: scene write sets, delete removes, whole save replaces', () => {
    bindStageSceneRevs('s1', { a: 3, b: 5 });
    applySceneRevsResult('PUT', '/documents/s1/scenes/a', encodeURIComponent('{"a":4}'));
    expect(sceneRev('s1', 'a')).toBe(4);
    applySceneRevsResult('DELETE', '/documents/s1/scenes/b', encodeURIComponent('{"b":null}'));
    expect(stageSceneRevs('s1')).toEqual({ a: 4 });
    applySceneRevsResult('PUT', '/documents/s1', encodeURIComponent('{"a":6,"c":1}'));
    expect(stageSceneRevs('s1')).toEqual({ a: 6, c: 1 });
    // Garbage and unbound stages are ignored.
    applySceneRevsResult('PUT', '/documents/s1/scenes/a', 'not json');
    applySceneRevsResult('PUT', '/documents/s2/scenes/a', encodeURIComponent('{"a":1}'));
    expect(stageSceneRevs('s1')).toEqual({ a: 6, c: 1 });
    expect(stageSceneRevs('s2')).toBeUndefined();
  });

  it('AT-RV 11: two sequential saves from one tab each send the revision the previous one produced', async () => {
    bindStageSceneRevs('s1', { a: 3 });
    let serverRev = 3;
    const base = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = decode((init?.headers as Record<string, string>)['x-tp-expected-scene-revs']);
      expect(sent).toEqual({ a: serverRev });
      serverRev += 1;
      return new Response(null, {
        status: 204,
        headers: { 'x-tp-scene-revs-result': encodeURIComponent(JSON.stringify({ a: serverRev })) },
      });
    });
    const tracked = revisionAwareFetch(base as unknown as typeof fetch);
    for (let save = 0; save < 2; save += 1) {
      const path = '/api/persistence/documents/s1/scenes/a';
      await tracked(path, {
        method: 'PUT',
        headers: { 'x-tp-expected-scene-revs': expectedSceneRevsHeader('PUT', path)! },
      });
    }
    expect(sceneRev('s1', 'a')).toBe(5);
  });

  it('a refused write teaches nothing', async () => {
    bindStageSceneRevs('s1', { a: 3 });
    const tracked = revisionAwareFetch(
      (async () =>
        new Response('{}', {
          status: 409,
          headers: { 'x-tp-scene-revs-result': encodeURIComponent('{"a":99}') },
        })) as unknown as typeof fetch,
    );
    await tracked('/api/persistence/documents/s1/scenes/a', { method: 'PUT' });
    expect(sceneRev('s1', 'a')).toBe(3);
    setSceneRev('s1', 'a', null);
    expect(stageSceneRevs('s1')).toEqual({});
  });
});

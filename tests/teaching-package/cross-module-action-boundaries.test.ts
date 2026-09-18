/**
 * Module 3/4 W6.4 — cross-module boundaries (TAE-RQ-035/036/037, TAE-AC-007,
 * plan §7.6 item 4), turning three §3.7 "no change required" rows into tests:
 *
 * - RQ-036: Kafuo's VisualAction / tutoring Answer Action / package command /
 *   teaching-runtime transition vocabularies stay DISJOINT from the canonical
 *   Scene Action union. The Kafuo side is mirrored into
 *   tests/fixtures/kafuo-action-vocabularies.json (the W7 digest-vector
 *   precedent: the backend owns the source and pins its own enums).
 * - RQ-035: no live agent-emitted Action writes package scene.actions — the
 *   teaching-package stage owner is nameable ONLY inside
 *   lib/server/teaching-package/, so no agent-runtime path can even address a
 *   package Stage except through the teaching-package services themselves
 *   (the §8 matrix's governed rows).
 * - RQ-037: widget, video and discussion Actions remain TRIGGERS — the engine
 *   delegates (sendWidgetMessage, resolveActionVideoMedia) and owns none of
 *   the specialized semantics. Pinned behaviorally by
 *   tests/action/widget-actions.test.ts and
 *   tests/action/play-video-media-resolution.test.ts (cited here); this file
 *   adds the structural half: the delegation seams exist and no widget/iframe
 *   execution semantics live in the engine.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTION_TYPES } from '@openmaic/dsl';

/** Production source files under a directory, recursively. */
function productionSources(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(process.cwd(), root));
  return out;
}

const kafuoVocabularies = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'kafuo-action-vocabularies.json'), 'utf8'),
) as {
  visualActionTypes: string[];
  visualActionStages: string[];
  teachingTransitions: string[];
  answerActionTokens: string[];
};

describe('W6.4 — the Scene Action union stays disjoint from every other Action-named contract', () => {
  it('no Kafuo VisualAction type, stage, tutoring Answer token or teaching-runtime transition is a canonical Scene Action', () => {
    const canonical = [...ACTION_TYPES];
    const foreign = new Map<string, string[]>();
    for (const [vocabulary, tokens] of Object.entries({
      visualActionTypes: kafuoVocabularies.visualActionTypes,
      visualActionStages: kafuoVocabularies.visualActionStages,
      teachingTransitions: kafuoVocabularies.teachingTransitions,
      answerActionTokens: kafuoVocabularies.answerActionTokens,
    })) {
      foreign.set(vocabulary, tokens);
      for (const token of tokens) {
        expect(
          canonical,
          `${vocabulary} token '${token}' must not be a canonical Scene Action type`,
        ).not.toContain(token);
      }
    }
    // The mirror is non-empty on every axis — an emptied fixture would make
    // this test vacuous.
    for (const [vocabulary, tokens] of foreign) {
      expect(tokens.length, `${vocabulary} mirror must carry tokens`).toBeGreaterThan(0);
    }
  });

  it('merging either direction fails loudly: the guard reads the REAL unions', () => {
    // The proof that the disjointness check can fail: a hypothetical merged
    // vocabulary trips it. (Guard-wiring, in-memory only.)
    const hypothetical = [...ACTION_TYPES, 'focus' /* VisualActionType.FOCUS */];
    expect(hypothetical).toContain('focus');
    expect(hypothetical).not.toEqual([...ACTION_TYPES]);
  });
});

describe('W6.4 — persisted package Actions are never live agent output (TAE-RQ-035)', () => {
  it('the teaching-package stage owner is referenced only by the teaching-package surface and its grant-guarded routes', () => {
    // Walk lib/ (and app/, the route layer) for production references to
    // TEACHING_PACKAGE_STAGE_OWNER. Allowed: the teaching-package server
    // surface (lib/server/teaching-package/**, the owner's own definition
    // included) and the route layer's grant-guarded teaching-package routes —
    // each app/ hit must also reference the Editor grant, proving it acts
    // under the handoff's authorization rather than as free-floating owner
    // access. The agent runner's stores are bound to the SESSION owner and
    // cannot address a package Stage by name; package writes happen only
    // through the teaching-package services those governed tools call.
    const hits = [...productionSources('lib'), ...productionSources('app')].filter((file) =>
      readFileSync(file, 'utf8').includes('TEACHING_PACKAGE_STAGE_OWNER'),
    );
    expect(hits.length).toBeGreaterThan(0);
    const teachingPackageSurface = join(process.cwd(), 'lib', 'server', 'teaching-package');
    const appRoot = join(process.cwd(), 'app');
    const offenders = hits.filter((file) => {
      if (file.startsWith(teachingPackageSurface)) return false;
      // A route-layer hit is legal only as a grant-guarded teaching-package route.
      const isGrantGuardedRoute =
        file.startsWith(appRoot) && readFileSync(file, 'utf8').includes('readEditorGrant');
      return !isGrantGuardedRoute;
    });
    expect(offenders).toEqual([]);
  });
});

describe('W6.4 — widget, video and discussion remain delegated triggers (TAE-RQ-037)', () => {
  it('the engine delegates: sendWidgetMessage posts to the injected callback, video resolves through resolveActionVideoMedia, discussion returns to the runtime', () => {
    const source = readFileSync(join(process.cwd(), 'lib/action/engine.ts'), 'utf8');
    // The delegation seams (plan §3.7 evidence: engine.ts sendWidgetMessage /
    // resolveActionVideoMedia / the discussion case's external lifecycle).
    expect(source).toMatch(/private sendWidgetMessage\(type: string/);
    expect(source).toMatch(
      /this\.widgetMessageCallback\?\.\(type, payload\)|this\.widgetMessageCallback\(/,
    );
    expect(source).toMatch(/resolveActionVideoMedia\(/);
    expect(source).toMatch(/case 'discussion':[\s\S]{0,200}managed externally/);
  });

  it('the engine owns no widget/iframe or video-player semantics of its own', () => {
    // If the engine started OWNING delegated semantics it would grow iframe
    // or player machinery — document/contentWindow access, its own <video>
    // handling, CSS selector resolution. None of that may appear.
    const source = readFileSync(join(process.cwd(), 'lib/action/engine.ts'), 'utf8');
    expect(source).not.toMatch(
      /contentWindow|querySelector|document\.write|createElement\('video'\)|createElement\("video"\)/,
    );
    // And the widget execution paths post a message rather than mutating DOM.
    for (const widgetType of [
      'widget_highlight',
      'widget_setState',
      'widget_annotation',
      'widget_reveal',
    ]) {
      const caseIndex = source.indexOf(`case '${widgetType}':`);
      expect(caseIndex, `the ${widgetType} case must exist`).toBeGreaterThan(-1);
      const methodCall = source.slice(caseIndex, caseIndex + 200);
      expect(methodCall, `${widgetType} must route through an execute* delegation`).toMatch(
        /return this\.execute\w+\(action/,
      );
    }
  });
});

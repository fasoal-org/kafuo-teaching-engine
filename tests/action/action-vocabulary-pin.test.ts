/**
 * Module 3/4 W6.1 — canonical-vocabulary preservation (TAE-RQ-001/002/003,
 * TAE-AC-001, plan §7.6 item 1).
 *
 * The union's compile-time exhaustiveness guard lives in the DSL itself
 * (`dsl/src/action.ts` — `[ActionType] extends [(typeof ACTION_TYPES)[number]]`),
 * and the existing editor/playback/action suites run unchanged as the RQ-003
 * behavioral gate (tests/edit/, tests/playback/, tests/action/). What no test
 * pinned is the RUNTIME contents: a silent edit that adds, removes, reorders
 * or re-spells a member — in the union or in any of the three behavior sets —
 * currently changes editor affordances, playback classification and write
 * validation with nothing failing. This file pins the exact vocabulary so any
 * such edit fails here first.
 *
 * The Action Engine's default-less no-op for unknown types (TAE-RQ-031) is
 * pinned by tests/action/unknown-type-noop.test.ts (W3) — cited, not
 * duplicated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ACTION_TYPES,
  FIRE_AND_FORGET_ACTIONS,
  SLIDE_ONLY_ACTIONS,
  SYNC_ACTIONS,
  isActionType,
  type Action,
  type ActionType,
} from '@openmaic/dsl';

/** The frozen V1 vocabulary, in canonical order (dsl/src/action.ts:290). */
const CANONICAL_ACTION_TYPES = [
  'spotlight',
  'laser',
  'play_video',
  'speech',
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_edit_code',
  'wb_clear',
  'wb_delete',
  'wb_close',
  'discussion',
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
] as const;

describe('W6.1 — the canonical Action vocabulary is pinned at the source', () => {
  it('ACTION_TYPES holds exactly the 21 members, in order', () => {
    expect([...ACTION_TYPES]).toEqual([...CANONICAL_ACTION_TYPES]);
    expect(ACTION_TYPES).toHaveLength(21);
  });

  it('the three behavior sets hold their exact members (no silent reclassification)', () => {
    expect(FIRE_AND_FORGET_ACTIONS).toEqual(['spotlight', 'laser']);
    expect(SLIDE_ONLY_ACTIONS).toEqual(['spotlight', 'laser']);
    expect(SYNC_ACTIONS).toEqual([
      'speech',
      'play_video',
      'wb_open',
      'wb_draw_text',
      'wb_draw_shape',
      'wb_draw_chart',
      'wb_draw_latex',
      'wb_draw_table',
      'wb_draw_line',
      'wb_draw_code',
      'wb_edit_code',
      'wb_clear',
      'wb_delete',
      'wb_close',
      'discussion',
      'widget_highlight',
      'widget_setState',
      'widget_annotation',
      'widget_reveal',
    ]);
    // Fire-and-forget and sync partition the vocabulary exactly — a new member
    // that lands in neither (or both) is a classification change, not an
    // addition.
    expect([...FIRE_AND_FORGET_ACTIONS, ...SYNC_ACTIONS].sort()).toEqual(
      [...CANONICAL_ACTION_TYPES].slice().sort(),
    );
    expect(FIRE_AND_FORGET_ACTIONS.every((type) => !SYNC_ACTIONS.includes(type))).toBe(true);
    // Slide-only is a subset restriction, never an expansion.
    expect(SLIDE_ONLY_ACTIONS.every((type) => FIRE_AND_FORGET_ACTIONS.includes(type))).toBe(true);
  });

  it('isActionType accepts exactly the members and refuses near-misses', () => {
    for (const type of CANONICAL_ACTION_TYPES) expect(isActionType(type)).toBe(true);
    // The historical corpus's invented types stay non-canonical — a rename or
    // re-spelling of a canonical member must not silently canonize history.
    for (const invented of [
      'legacy_confetti_burst',
      'teleport',
      'widget_setstate' /* case drift */,
      'spotlights' /* plural drift */,
      'next_card' /* a Kafuo transition, never canonical here */,
    ]) {
      expect(isActionType(invented), invented).toBe(false);
    }
  });

  it("TAE-RQ-002: Scene actions remain a Scene-owned ordered array — the union is the type of that array's elements", () => {
    // Type-level: `Action['type']` is exactly the closed union — an parallel
    // taxonomy would have to widen or replace this equivalence.
    expectTypeOf<Action['type']>().toEqualTypeOf<ActionType>();
    expectTypeOf<ActionType>().toEqualTypeOf<(typeof ACTION_TYPES)[number]>();
  });

  it('TAE-RQ-002: the playback engine consumes scene.actions in array order — no reordering before execution', () => {
    // Source pin on the sequencing seam (plan §3.7 evidence: playback/engine.ts
    // walks the actions array by index): the engine may not sort, reverse or
    // otherwise reorder the persisted array before executing it — array
    // position IS execution order.
    const source = readFileSync(join(process.cwd(), 'lib/playback/engine.ts'), 'utf8');
    const reorderPatterns = [
      /\.actions\s*\.\s*sort\s*\(/,
      /\.actions\s*\.\s*toSorted\s*\(/,
      /\.actions\s*\.\s*reverse\s*\(/,
      /\.actions\s*\.\s*toReversed\s*\(/,
    ];
    for (const pattern of reorderPatterns) {
      expect(source, `lib/playback/engine.ts must not match ${pattern}`).not.toMatch(pattern);
    }
    // The cursor advances through the array the scene owns, one index at a time.
    expect(source).toMatch(/this\.actionIndex\+\+|this\.actionIndex \+= 1/);
  });
});

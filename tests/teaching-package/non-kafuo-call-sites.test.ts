/**
 * The three non-Kafuo call sites of the shared scene generators (Module 2 W11 —
 * plan §B.10/§O-4a): they must stay byte-identical when Teaching Skills land.
 *
 * `generateSceneContent` / `generateSceneActions` are shared by four call
 * sites; only the Kafuo package path (classroom-generation.ts) is governed.
 * The governed prompt-assembly change is gated on `resolvedSkills` being
 * supplied — so the pin is structural and two-layered:
 *
 * 1. SOURCE PIN — the three ungoverned call sites never pass `resolvedSkills`
 *    (a future edit that threads it there fails this test loudly instead of
 *    silently changing Workbench/editor/route prompts).
 * 2. BEHAVIORAL PIN (package level, scene-skill-context.test.ts) — even an
 *    outline carrying a `teachingSkills` carrier renders byte-identical
 *    prompts when no `resolvedSkills` are supplied.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The four shared-generator call sites (plan §B.10 table). */
const CALL_SITES = {
  'Kafuo package generation (governed — the only site that may pass resolvedSkills)':
    'lib/server/classroom-generation.ts',
  'Workbench agent generate_scene (must stay byte-identical)':
    'lib/server/agent-runtime/generation-tools.ts',
  'Editor scene regeneration (must stay byte-identical)': 'lib/server/scene-generation.ts',
  'Scene-actions route (must stay byte-identical)': 'app/api/generate/scene-actions/route.ts',
} as const;

describe('non-Kafuo call sites of the shared scene generators (W11 + Module 3/4 W1/W4)', () => {
  it('only the Kafuo path supplies resolvedSkills to the shared generators', () => {
    for (const [label, relativePath] of Object.entries(CALL_SITES)) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf-8');
      if (relativePath === 'lib/server/classroom-generation.ts') {
        expect(source, label).toMatch(/resolvedSkills/);
      } else if (relativePath === 'lib/server/agent-runtime/generation-tools.ts') {
        // W4 (plan §11): the agent tools DO supply Skills/Flow now — but only
        // on a governed Stage, inside the resolved-context conditional. The
        // non-governed (Workbench, non-package Stage) behavior is byte-identical,
        // proven behaviorally by the tier-B case in
        // tests/agent-runtime/generation-tools-governed.test.ts.
        const ungated = source
          .split('\n')
          .filter((line) => line.includes('resolvedSkills') && !line.includes('governed'));
        expect(ungated, `${label}: every resolvedSkills reference is governed-gated`).toEqual([]);
      } else {
        // The invariant that keeps these sites byte-identical: the governed
        // prompt block is unreachable without the definitions.
        expect(source, label).not.toContain('resolvedSkills');
      }
    }
  });

  it('only the Kafuo path supplies flowContext to the shared action generator (W1/W4)', () => {
    // Same structural pin for the W1 Flow block: the three non-Kafuo sites
    // never pass `flowContext` unconditionally, so the Teaching Model Flow
    // Authority block is unreachable there and their action prompts stay
    // byte-identical. The agent-tools exception is W4's governed branch.
    for (const [label, relativePath] of Object.entries(CALL_SITES)) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf-8');
      if (relativePath === 'lib/server/classroom-generation.ts') {
        expect(source, label).toMatch(/flowContext/);
      } else if (relativePath === 'lib/server/agent-runtime/generation-tools.ts') {
        const ungated = source
          .split('\n')
          .filter((line) => line.includes('flowContext') && !line.includes('governed'));
        expect(ungated, `${label}: every flowContext reference is governed-gated`).toEqual([]);
      } else {
        expect(source, label).not.toContain('flowContext');
      }
    }
  });

  it('the Kafuo path gates the definitions on the single governed-mode predicate', () => {
    const source = readFileSync(join(repoRoot, 'lib/server/classroom-generation.ts'), 'utf-8');
    // W1: mode derives once from the marker-built `governed` authority value —
    // never re-tested per site, and ungoverned Kafuo runs (tier B) render
    // byte-identically too.
    expect(source).toMatch(/input\.governed[\s\S]{0,200}resolveFlowSkillPolicies/);
  });
});

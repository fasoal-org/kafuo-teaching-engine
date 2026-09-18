/**
 * The three non-Kafuo call sites of the shared scene generators (Module 2 W11 —
 * plan §B.10/§O-4a): they must stay byte-identical when Teaching Skills land.
 *
 * `generateSceneContent` / `generateSceneActions` are shared by four call
 * sites; only the Kafuo package path (classroom-generation.ts) is governed.
 * The governed prompt-assembly change is gated on `resolvedSkills` being
 * supplied — so the pin is structural and two-layered:
 *
 * 1. SOURCE PIN — the two ungoverned call sites that must be byte-identical
 *    in the strong sense (editor scene regeneration, scene-actions route)
 *    never mention `resolvedSkills`/`flowContext` at all, so the governed
 *    prompt block is unreachable there by construction.
 * 2. BEHAVIORAL PIN — the Workbench agent tools (generation-tools.ts) are NOT
 *    byte-protected on a Teaching Package Stage (plan §11, W4): they DO
 *    mention both symbols, inside the resolved governed-context branch. Their
 *    non-governed behavior is carried ENTIRELY by the tier-B behavioral case
 *    in tests/agent-runtime/generation-tools-governed.test.ts ("prompts and
 *    writes stay legacy"), which captures the assembled prompts on a tier-B
 *    Stage and asserts the governed blocks are absent.
 *
 *    F-1 (Gate 3 review): this file previously kept a line-level substring
 *    heuristic here (every `resolvedSkills` line must also contain the
 *    substring `governed`) — a comment or an identifier like
 *    `governedFallback` satisfied it, so it implied a structural guarantee it
 *    could not provide. A branch-aware source scan would be the same claim one
 *    heuristic later: regex-over-source cannot prove a reference EXECUTES only
 *    under the resolved governed context. The honest fix is to make no source
 *    claim for this call site and let the behavioral test that actually fails
 *    when the invariant breaks carry it alone. A pin that cannot fail for the
 *    reason it claims is worse than no pin.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The byte-protected call sites (plan §11). generation-tools.ts is
 * deliberately absent — see the file header and the behavioral pin named
 * there.
 */
const BYTE_PROTECTED_CALL_SITES = {
  'Editor scene regeneration (must stay byte-identical)': 'lib/server/scene-generation.ts',
  'Scene-actions route (must stay byte-identical)': 'app/api/generate/scene-actions/route.ts',
} as const;

const KAFUO_PATH = 'lib/server/classroom-generation.ts';

describe('non-Kafuo call sites of the shared scene generators (W11 + Module 3/4 W1/W4/W6)', () => {
  it('only the Kafuo path supplies resolvedSkills to the shared generators', () => {
    expect(
      readFileSync(join(repoRoot, KAFUO_PATH), 'utf-8'),
      'the Kafuo path is the governed one and must pass resolvedSkills',
    ).toMatch(/resolvedSkills/);
    for (const [label, relativePath] of Object.entries(BYTE_PROTECTED_CALL_SITES)) {
      // The invariant that keeps these sites byte-identical: the governed
      // prompt block is unreachable without the definitions.
      expect(readFileSync(join(repoRoot, relativePath), 'utf-8'), label).not.toContain(
        'resolvedSkills',
      );
    }
  });

  it('only the Kafuo path supplies flowContext to the shared action generator (W1/W4)', () => {
    // Same structural pin for the W1 Flow block: the two byte-protected sites
    // never pass `flowContext`, so the Teaching Model Flow Authority block is
    // unreachable there and their action prompts stay byte-identical. The
    // agent-tools exception is W4's governed branch, carried behaviorally
    // (see the file header).
    expect(
      readFileSync(join(repoRoot, KAFUO_PATH), 'utf-8'),
      'the Kafuo path is the governed one and must pass flowContext',
    ).toMatch(/flowContext/);
    for (const [label, relativePath] of Object.entries(BYTE_PROTECTED_CALL_SITES)) {
      expect(readFileSync(join(repoRoot, relativePath), 'utf-8'), label).not.toContain(
        'flowContext',
      );
    }
  });

  it('the Kafuo path gates the definitions on the single governed-mode predicate', () => {
    const source = readFileSync(join(repoRoot, KAFUO_PATH), 'utf-8');
    // W1: mode derives once from the marker-built `governed` authority value —
    // never re-tested per site, and ungoverned Kafuo runs (tier B) render
    // byte-identically too.
    expect(source).toMatch(/input\.governed[\s\S]{0,200}resolveFlowSkillPolicies/);
  });
});

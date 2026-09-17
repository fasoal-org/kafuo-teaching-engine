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

describe('non-Kafuo call sites of the shared scene generators (W11)', () => {
  it('only the Kafuo path supplies resolvedSkills to the shared generators', () => {
    for (const [label, relativePath] of Object.entries(CALL_SITES)) {
      const source = readFileSync(join(repoRoot, relativePath), 'utf-8');
      if (relativePath === 'lib/server/classroom-generation.ts') {
        expect(source, label).toMatch(/resolvedSkills/);
      } else {
        // The invariant that keeps these three sites byte-identical: the
        // governed prompt block is unreachable without the definitions.
        expect(source, label).not.toContain('resolvedSkills');
      }
    }
  });

  it('the Kafuo path gates the definitions on the derived governance mode', () => {
    const source = readFileSync(join(repoRoot, 'lib/server/classroom-generation.ts'), 'utf-8');
    // Mode derived once (W10's skillPolicy value), never re-tested per site —
    // and ungoverned Kafuo runs (tier B) render byte-identically too.
    expect(source).toMatch(/input\.skillPolicy[\s\S]{0,200}resolveFlowSkillPolicies/);
  });
});

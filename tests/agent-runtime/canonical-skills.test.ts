/**
 * Canonical Teaching Skill version registry — Module 2 Wave 1 (plan §E, §P Step 1).
 *
 * Pins the four-part identity (stable id + declared immutable version + retained
 * historical definition + content digest) and the exact-version-only resolution
 * semantics: v1 still resolves after v2 ships, byte drift in a declared version
 * is detected through the digest, an absent retained definition reports
 * SKILL_LINEAGE_UNRESOLVABLE (409) and never substitutes a newer version
 * (FR-TS-034/035/036/069, VAL-TS-001/002/019, AC-TS-012), and retained
 * versions stay invisible to the active catalog (§B.9).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills, type Skill } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalSkillVersion,
  verifyCanonicalSkillVersions,
} from '@/lib/server/agent-runtime/canonical-skills';
import { listSkills, skillSourceHash } from '@/lib/server/agent-runtime/skills';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

const realCatalogRoot = join(process.cwd(), 'skills/agent-runtime');

/** Minimal valid frontmatter so fixture skills are also loadable by pi. */
const skillFileText = (id: string, body: string): string =>
  `---\nname: ${id}\ndescription: "${id} fixture skill"\n---\n\n# ${id}\n\n${body}\n`;

function writeRetainedVersion(
  root: string,
  id: string,
  version: string,
  text: string,
): { digest: string } {
  const dir = join(root, id, 'versions', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
  return { digest: skillSourceHash(text) };
}

function writeManifest(
  root: string,
  id: string,
  currentVersion: string,
  versions: Record<string, { digest: string }>,
): void {
  writeFileSync(
    join(root, id, 'skill-versions.json'),
    `${JSON.stringify({ recordVersion: 1, currentVersion, versions }, null, 2)}\n`,
  );
}

/** Register a fixture skill at v1: top-level SKILL.md + retained snapshot + manifest. */
function shipV1(root: string, id: string): string {
  const text = skillFileText(id, 'Original v1 pedagogy.');
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'SKILL.md'), text);
  const { digest } = writeRetainedVersion(root, id, 'v1', text);
  writeManifest(root, id, 'v1', { v1: { digest } });
  return text;
}

/** Ship v2 over an existing v1: top-level becomes v2, v1 is retained untouched. */
function shipV2(root: string, id: string): string {
  const text = skillFileText(id, 'Rewritten v2 pedagogy with a different teaching strategy.');
  writeFileSync(join(root, id, 'SKILL.md'), text);
  const v2 = writeRetainedVersion(root, id, 'v2', text);
  const v1Digest = skillSourceHash(
    readFileSync(join(root, id, 'versions', 'v1', 'SKILL.md'), 'utf8'),
  );
  writeManifest(root, id, 'v2', { v1: { digest: v1Digest }, v2: { digest: v2.digest } });
  return text;
}

const withTempRegistry = (): string => mkdtempSync(join(tmpdir(), 'openmaic-canonical-skill-'));

/**
 * Assert a resolution fails the ONE way W1 allows: SKILL_LINEAGE_UNRESOLVABLE
 * at 409, carrying skillId/version details. Returns the error for detail checks.
 */
function expectUnresolvable(act: () => unknown): TeachingPackageError {
  let thrown: unknown;
  try {
    act();
  } catch (err) {
    thrown = err;
  }
  if (!(thrown instanceof TeachingPackageError)) {
    throw new Error(`expected SKILL_LINEAGE_UNRESOLVABLE, got ${String(thrown)}`);
  }
  expect(thrown.code).toBe('SKILL_LINEAGE_UNRESOLVABLE');
  expect(thrown.status).toBe(409);
  return thrown;
}

describe('canonical skill version registry — exact-version resolution', () => {
  it('resolves the declared version from its retained snapshot', () => {
    const root = withTempRegistry();
    try {
      const v1 = shipV1(root, 'fixture-skill');
      const resolved = resolveCanonicalSkillVersion('fixture-skill', 'v1', root);
      expect(resolved).toEqual({
        skillId: 'fixture-skill',
        version: 'v1',
        content: v1,
        digest: skillSourceHash(v1),
        filePath: join(root, 'fixture-skill', 'versions', 'v1', 'SKILL.md'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps v1 resolvable after v2 ships, byte-for-byte (AC-TS-012, FR-TS-034)', () => {
    const root = withTempRegistry();
    try {
      const v1 = shipV1(root, 'fixture-skill');
      const v2 = shipV2(root, 'fixture-skill');

      const resolvedV1 = resolveCanonicalSkillVersion('fixture-skill', 'v1', root);
      expect(resolvedV1.content).toBe(v1);
      expect(resolvedV1.digest).toBe(skillSourceHash(v1));

      const resolvedV2 = resolveCanonicalSkillVersion('fixture-skill', 'v2', root);
      expect(resolvedV2.content).toBe(v2);
      expect(resolvedV2.digest).toBe(skillSourceHash(v2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an undeclared version and never substitutes a newer one (FR-TS-036, VAL-TS-019)', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');
      const v2 = shipV2(root, 'fixture-skill');

      const error = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('fixture-skill', 'v3', root),
      );
      const details = error.details as Record<string, unknown>;
      expect(details.reason).toBe('version_not_declared');
      expect(details.skillId).toBe('fixture-skill');
      expect(details.version).toBe('v3');
      // The registry knew v1 and v2 existed and refused anyway — that is the
      // no-substitution evidence.
      expect(details.declaredVersions).toEqual(['v1', 'v2']);

      // The content digest is a drift guard, not a version identity (R-2):
      // resolving BY digest string is just an undeclared version reference.
      const byDigest = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('fixture-skill', skillSourceHash(v2), root),
      );
      expect((byDigest.details as Record<string, unknown>).reason).toBe('version_not_declared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unknown or malformed skill id without touching the filesystem (VAL-TS-001)', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');

      for (const unknownId of ['no-such-skill', '../escape', 'a/b']) {
        const error = expectUnresolvable(() => resolveCanonicalSkillVersion(unknownId, 'v1', root));
        expect((error.details as Record<string, unknown>).reason).toBe('skill_unknown');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the retained snapshot is absent, without affecting other versions (§24.3)', () => {
    const root = withTempRegistry();
    try {
      const v1 = shipV1(root, 'fixture-skill');
      const v2 = shipV2(root, 'fixture-skill');
      rmSync(join(root, 'fixture-skill', 'versions', 'v1'), { recursive: true, force: true });

      const error = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('fixture-skill', 'v1', root),
      );
      expect((error.details as Record<string, unknown>).reason).toBe('snapshot_missing');

      // v2's retained definition is genuinely present and still resolves; v1's
      // absence was reported, not papered over with v2.
      expect(resolveCanonicalSkillVersion('fixture-skill', 'v2', root).content).toBe(v2);
      expect(v1).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when retained bytes drift from the declared digest (FR-TS-069)', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');
      const snapshot = join(root, 'fixture-skill', 'versions', 'v1', 'SKILL.md');
      const original = readFileSync(snapshot, 'utf8');
      writeFileSync(snapshot, `${original}\nSilently mutated retained definition.\n`);

      const error = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('fixture-skill', 'v1', root),
      );
      const details = error.details as Record<string, unknown>;
      expect(details.reason).toBe('digest_mismatch');
      expect(details.declaredDigest).toBe(skillSourceHash(original));
      expect(details.retainedDigest).not.toBe(details.declaredDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a skill with no declared versions (manifest absent)', () => {
    const root = withTempRegistry();
    try {
      mkdirSync(join(root, 'unregistered-skill'), { recursive: true });
      writeFileSync(
        join(root, 'unregistered-skill', 'SKILL.md'),
        skillFileText('unregistered-skill', 'active catalog file, no registry entry'),
      );

      const error = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('unregistered-skill', 'v1', root),
      );
      expect((error.details as Record<string, unknown>).reason).toBe('manifest_absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses malformed manifests instead of guessing (fail-closed)', () => {
    const root = withTempRegistry();
    try {
      const v1 = shipV1(root, 'fixture-skill');
      const v1Digest = skillSourceHash(v1);
      const manifest = join(root, 'fixture-skill', 'skill-versions.json');

      const cases: [string, string][] = [
        ['unparseable JSON', '{ nope'],
        [
          'unsupported recordVersion',
          JSON.stringify({
            recordVersion: 2,
            currentVersion: 'v1',
            versions: { v1: { digest: v1Digest } },
          }),
        ],
        [
          'currentVersion not declared',
          JSON.stringify({
            recordVersion: 1,
            currentVersion: 'v9',
            versions: { v1: { digest: v1Digest } },
          }),
        ],
        [
          'digest not a 16-hex sha256 prefix',
          JSON.stringify({
            recordVersion: 1,
            currentVersion: 'v1',
            versions: { v1: { digest: 'ZZZZ' } },
          }),
        ],
        [
          'no declared versions',
          JSON.stringify({ recordVersion: 1, currentVersion: 'v1', versions: {} }),
        ],
      ];
      for (const [label, raw] of cases) {
        writeFileSync(manifest, raw);
        const error = expectUnresolvable(() =>
          resolveCanonicalSkillVersion('fixture-skill', 'v1', root),
        );
        expect((error.details as Record<string, unknown>).reason, label).toBe('manifest_invalid');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never resolves a workbench/user-authored skill id (FR-TS-062, AC-TS-025)', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'builtin-fixture');
      // User Skills live in the owner-scoped database under my-* handles, not
      // in the canonical tree — the registry has no owner dimension at all, so
      // such an id is simply unknown here.
      const error = expectUnresolvable(() =>
        resolveCanonicalSkillVersion('my-own-skill', 'v1', root),
      );
      expect((error.details as Record<string, unknown>).reason).toBe('skill_unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('canonical skill version registry — verification', () => {
  it('reports a healthy registry as ok', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');
      expect(verifyCanonicalSkillVersions(root)).toEqual([
        { skillId: 'fixture-skill', status: 'ok', currentVersion: 'v1', versions: ['v1'] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags drifted snapshots and undisciplined top-level edits (plan §O-1)', () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');

      const snapshot = join(root, 'fixture-skill', 'versions', 'v1', 'SKILL.md');
      writeFileSync(snapshot, `${readFileSync(snapshot, 'utf8')}\ndrift\n`);
      const drifted = verifyCanonicalSkillVersions(root);
      expect(drifted[0]!.status).toBe('invalid');
      expect(drifted[0]!.status === 'invalid' && drifted[0].problems.join(' ')).toContain(
        'retained bytes drifted',
      );

      // Restore the snapshot, then edit the ACTIVE file without shipping a new
      // version — the ordinary-development hazard the digest must catch.
      shipV1(root, 'fixture-skill');
      writeFileSync(
        join(root, 'fixture-skill', 'SKILL.md'),
        skillFileText('fixture-skill', 'edited in place, no new version'),
      );
      const undisciplined = verifyCanonicalSkillVersions(root);
      expect(undisciplined[0]!.status).toBe('invalid');
      expect(
        undisciplined[0]!.status === 'invalid' && undisciplined[0].problems.join(' '),
      ).toContain('no longer matches declared current version v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports manifest-less skills as no_manifest and tolerates a missing root', () => {
    const root = withTempRegistry();
    try {
      mkdirSync(join(root, 'plain-skill'), { recursive: true });
      writeFileSync(join(root, 'plain-skill', 'SKILL.md'), skillFileText('plain-skill', 'body'));
      expect(verifyCanonicalSkillVersions(root)).toEqual([
        { skillId: 'plain-skill', status: 'no_manifest' },
      ]);
      expect(verifyCanonicalSkillVersions(join(root, 'does-not-exist'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('canonical skill version registry — shipped catalog', () => {
  it('registers every shipped skill with an intact retained v1 (FR-TS-001, FR-TS-069)', () => {
    const results = verifyCanonicalSkillVersions(realCatalogRoot);
    const shipped = readdirSync(realCatalogRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(realCatalogRoot, entry.name, 'SKILL.md')),
      )
      .map((entry) => entry.name);

    expect(shipped.length).toBeGreaterThanOrEqual(16);
    expect(results.map((r) => r.skillId)).toEqual([...shipped].sort((a, b) => a.localeCompare(b)));
    for (const result of results) {
      expect(result.status, result.skillId).toBe('ok');
      if (result.status === 'ok') expect(result.versions, result.skillId).toContain('v1');
    }
  });

  it('resolves a real catalog skill at its declared version, byte-identical to the active file', () => {
    const active = readFileSync(join(realCatalogRoot, 'feynman-learning', 'SKILL.md'), 'utf8');
    const resolved = resolveCanonicalSkillVersion('feynman-learning', 'v1', realCatalogRoot);
    expect(resolved.content).toBe(active);
    expect(resolved.digest).toBe(skillSourceHash(active));
  });
});

describe('retained versions are invisible to the active catalog (§B.9)', () => {
  it('listSkills() never surfaces retained versions — one entry per top-level skill', async () => {
    const all = await listSkills();
    const topLevel = readdirSync(realCatalogRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(realCatalogRoot, entry.name, 'SKILL.md')),
      )
      .map((entry) => entry.name);

    // The count pin: if any consumer walk descended into versions/, the loader
    // would return the retained snapshots as extra (duplicate-name) skills.
    expect(all.map((s) => s.id).sort()).toEqual([...topLevel].sort());
    for (const skill of all) {
      expect(skill.filePath, skill.id).not.toMatch(/[/\\]versions[/\\]/);
      expect(skill.filePath).toBe(join(realCatalogRoot, skill.id, 'SKILL.md'));
    }
  });

  it("pi's loader early-returns on the top-level SKILL.md and never descends into versions/", async () => {
    const root = withTempRegistry();
    try {
      shipV1(root, 'fixture-skill');
      // Simulate a post-v2 state: the active file is v2 while v1 is retained.
      writeFileSync(
        join(root, 'fixture-skill', 'SKILL.md'),
        skillFileText('fixture-skill', 'v2 body'),
      );

      const env = new NodeExecutionEnv({ cwd: root });
      const { skills, diagnostics } = await loadSkills(env, root);
      expect(diagnostics).toEqual([]);
      const loaded: Skill[] = skills;
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.name).toBe('fixture-skill');
      expect(loaded[0]!.content).toContain('v2 body');
      expect(loaded[0]!.content).not.toContain('Original v1 pedagogy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

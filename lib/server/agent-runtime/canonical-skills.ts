/**
 * Canonical Teaching Skill version registry — Module 2 Wave 1 (plan §E, §P Step 1).
 *
 * A canonical Skill definition carries a four-part identity (plan R-2, CLOSED):
 *
 *   stable canonical Skill ID        — the existing skill directory name (`LoadedSkill.id`)
 *   + declared immutable version     — business-facing; authored in the sibling
 *                                      `skill-versions.json` manifest, the file policy
 *                                      references. Sibling rather than frontmatter for the
 *                                      same reason `outline-constraints.json` is: "the
 *                                      frontmatter is the model-visible contract, this is
 *                                      the checker's" (`skills.ts`).
 *   + retained historical definition — `<skill>/versions/<version>/SKILL.md`, the exact
 *                                      bytes that version shipped with, still readable
 *                                      after a newer version exists
 *   + content digest                 — `skillSourceHash` over the retained bytes. An
 *                                      integrity/drift guard ONLY: it proves a declared
 *                                      version's bytes have not changed underneath it.
 *                                      It is NOT the business-facing version and must
 *                                      never be used as one.
 *
 * Resolution is EXACT-VERSION ONLY. There is no "latest" path, no floating, and no
 * fallback: a version that is undeclared, absent, or drifted reports
 * `SKILL_LINEAGE_UNRESOLVABLE` and never substitutes a newer definition
 * (FR-TS-034/035/036/069, VAL-TS-001/002/019, AC-TS-012).
 *
 * Scope: the registry covers the built-in catalog only. Owner-scoped user Skills
 * are a separate Workbench capability and are never canonical-selectable
 * (FR-TS-062, AC-TS-025) — they live in the database, not in this tree, and an
 * unknown id is simply unresolvable here.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

import { skillsDir, skillSourceHash } from './skills';

/** The checker-owned sibling of SKILL.md that declares this skill's versions. */
export const SKILL_VERSIONS_MANIFEST_FILENAME = 'skill-versions.json';

/**
 * Conservative identity syntax for skill ids and declared versions. Exists to
 * keep both out of path traversal and filesystem-special territory; it is not a
 * product versioning scheme. `v1`, `v2.1`, `2026-09-17` all fit.
 */
export const CANONICAL_SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CANONICAL_SKILL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `skillSourceHash` output shape: 16 lowercase hex characters. */
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

interface ManifestEntry {
  digest: string;
}

/** The parsed shape of `<skill>/skill-versions.json`. */
export interface CanonicalSkillVersionManifest {
  recordVersion: 1;
  /** The version the top-level SKILL.md currently ships; must be declared in `versions`. */
  currentVersion: string;
  versions: Record<string, ManifestEntry>;
}

/**
 * A resolved canonical Skill definition at one exact immutable version — the
 * lineage-facing counterpart of `LoadedSkill`, which stays the ACTIVE-catalog
 * shape and is deliberately untouched by this registry.
 */
export interface CanonicalSkillDefinition {
  /** Stable canonical Skill ID — the skill directory name. */
  skillId: string;
  /** The declared immutable version — the business-facing identity policy references. */
  version: string;
  /** The exact retained SKILL.md text for this version (frontmatter + body). */
  content: string;
  /** `skillSourceHash(content)` — drift/integrity guard only, never a version identity. */
  digest: string;
  /** Path of the retained snapshot: `<skillsDir>/<skillId>/versions/<version>/SKILL.md`. */
  filePath: string;
}

/** Why an exact version could not be resolved. Every outcome fails closed. */
export type CanonicalSkillResolutionIssue =
  | { reason: 'skill_unknown' }
  | { reason: 'manifest_absent' }
  | { reason: 'manifest_invalid'; problem: string }
  | { reason: 'version_not_declared'; declaredVersions: string[] }
  | { reason: 'snapshot_missing' }
  | { reason: 'digest_mismatch'; declaredDigest: string; retainedDigest: string };

function manifestPath(dir: string, skillId: string): string {
  return join(dir, skillId, SKILL_VERSIONS_MANIFEST_FILENAME);
}

function retainedSnapshotPath(dir: string, skillId: string, version: string): string {
  return join(dir, skillId, 'versions', version, 'SKILL.md');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and shape-validate a manifest. Strict on everything the registry relies
 * on; unknown extra fields are tolerated. Returns the problem as a string so
 * callers can fold it into either a resolution refusal or a verification row.
 */
function parseManifest(
  text: string,
): { manifest: CanonicalSkillVersionManifest } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { problem: `unparseable JSON: ${String(err)}` };
  }
  if (!isPlainObject(raw)) return { problem: 'manifest root is not a JSON object' };
  if (raw.recordVersion !== 1) {
    return { problem: `unsupported manifest recordVersion ${JSON.stringify(raw.recordVersion)}` };
  }
  const currentVersion = raw.currentVersion;
  if (typeof currentVersion !== 'string' || !CANONICAL_SKILL_VERSION_PATTERN.test(currentVersion)) {
    return { problem: `invalid currentVersion ${JSON.stringify(currentVersion)}` };
  }
  const versionsRaw = raw.versions;
  if (!isPlainObject(versionsRaw)) return { problem: 'versions is not a JSON object' };
  const versions: Record<string, ManifestEntry> = {};
  for (const [version, entry] of Object.entries(versionsRaw)) {
    if (!CANONICAL_SKILL_VERSION_PATTERN.test(version)) {
      return { problem: `invalid declared version key ${JSON.stringify(version)}` };
    }
    if (!isPlainObject(entry) || typeof entry.digest !== 'string') {
      return { problem: `version ${version} has no string digest` };
    }
    if (!DIGEST_PATTERN.test(entry.digest)) {
      return { problem: `version ${version} digest is not a 16-hex-character sha256 prefix` };
    }
    versions[version] = { digest: entry.digest };
  }
  if (Object.keys(versions).length === 0) return { problem: 'no declared versions' };
  if (!(currentVersion in versions)) {
    return { problem: `currentVersion ${currentVersion} is not declared in versions` };
  }
  return { manifest: { recordVersion: 1, currentVersion, versions } };
}

function readManifest(
  dir: string,
  skillId: string,
): { manifest: CanonicalSkillVersionManifest } | CanonicalSkillResolutionIssue {
  const path = manifestPath(dir, skillId);
  if (!existsSync(path)) return { reason: 'manifest_absent' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { reason: 'manifest_invalid', problem: `unreadable: ${String(err)}` };
  }
  const parsed = parseManifest(text);
  if ('problem' in parsed) return { reason: 'manifest_invalid', problem: parsed.problem };
  return parsed;
}

/**
 * Resolve one exact canonical Skill version from its retained snapshot.
 *
 * Throws `TeachingPackageError('SKILL_LINEAGE_UNRESOLVABLE', …)` — status 409,
 * the status this codebase already uses for lineage failures — for every
 * unresolvable outcome. It never returns a different version than the one
 * asked for, and there is no code path that resolves "whatever is current".
 */
export function resolveCanonicalSkillVersion(
  skillId: string,
  version: string,
  dir: string = skillsDir,
): CanonicalSkillDefinition {
  const issue = (detail: CanonicalSkillResolutionIssue): TeachingPackageError =>
    new TeachingPackageError(
      'SKILL_LINEAGE_UNRESOLVABLE',
      `canonical skill ${JSON.stringify(skillId)} version ${JSON.stringify(version)} cannot be resolved (${detail.reason})`,
      { skillId, version, ...detail },
    );

  // Identity syntax is validated before the filesystem is touched, so a
  // malformed or traversal-shaped id is an unresolvable reference, never an
  // fs error and never a lookup outside the registry root.
  if (!CANONICAL_SKILL_ID_PATTERN.test(skillId)) throw issue({ reason: 'skill_unknown' });
  if (!CANONICAL_SKILL_VERSION_PATTERN.test(version)) {
    throw issue({ reason: 'version_not_declared', declaredVersions: [] });
  }
  if (!existsSync(join(dir, skillId))) throw issue({ reason: 'skill_unknown' });

  const manifestResult = readManifest(dir, skillId);
  if ('reason' in manifestResult) throw issue(manifestResult);
  const { manifest } = manifestResult;

  const declaredVersions = Object.keys(manifest.versions).sort();
  const entry = manifest.versions[version];
  if (!entry) {
    throw issue({ reason: 'version_not_declared', declaredVersions });
  }

  const filePath = retainedSnapshotPath(dir, skillId, version);
  if (!existsSync(filePath)) throw issue({ reason: 'snapshot_missing' });

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    throw issue({ reason: 'snapshot_missing' });
  }
  const digest = skillSourceHash(content);
  if (digest !== entry.digest) {
    throw issue({
      reason: 'digest_mismatch',
      declaredDigest: entry.digest,
      retainedDigest: digest,
    });
  }

  return { skillId, version, content, digest, filePath };
}

/** One skill's registry verification outcome. */
export type CanonicalSkillVersionStatus =
  | { skillId: string; status: 'ok'; currentVersion: string; versions: string[] }
  /** Active-catalog skill without a manifest — allowed for custom mounted sets, a gap for this repo's. */
  | { skillId: string; status: 'no_manifest' }
  | { skillId: string; status: 'invalid'; problems: string[] };

/**
 * Verify the version registry over a skills tree, top-level skill directories
 * only (retained `versions/` snapshots are per-skill artifacts, not skills).
 *
 * Checks, per skill: the manifest parses and is internally coherent; every
 * declared version has a retained snapshot whose digest matches the manifest;
 * and — the ordinary-development guard, plan §O-1 — the top-level SKILL.md,
 * when present, still hashes to the CURRENT version's declared digest, so a
 * release that edits a SKILL.md without shipping a new version is caught here
 * rather than silently changing a definition historical packages reference.
 *
 * Reporting is per-skill and total; nothing throws. Enforcement is the
 * caller's: this repo pins its shipped catalog in tests, so an undisciplined
 * SKILL.md edit fails the build (FR-TS-069).
 */
export function verifyCanonicalSkillVersions(
  dir: string = skillsDir,
): CanonicalSkillVersionStatus[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const results: CanonicalSkillVersionStatus[] = [];
  for (const entry of entries) {
    const skillId = entry.name;
    const skillRoot = join(dir, skillId);
    const manifestFile = join(skillRoot, SKILL_VERSIONS_MANIFEST_FILENAME);
    if (!existsSync(manifestFile)) {
      results.push({ skillId, status: 'no_manifest' });
      continue;
    }
    const manifestResult = readManifest(dir, skillId);
    if ('reason' in manifestResult) {
      results.push({
        skillId,
        status: 'invalid',
        problems: [
          manifestResult.reason === 'manifest_invalid'
            ? `manifest invalid: ${manifestResult.problem}`
            : `manifest ${manifestResult.reason}`,
        ],
      });
      continue;
    }
    const { manifest } = manifestResult;
    const problems: string[] = [];
    for (const [version, { digest }] of Object.entries(manifest.versions).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const snapshot = retainedSnapshotPath(dir, skillId, version);
      if (!existsSync(snapshot)) {
        problems.push(`version ${version}: retained snapshot missing at ${snapshot}`);
        continue;
      }
      const actual = skillSourceHash(readFileSync(snapshot, 'utf8'));
      if (actual !== digest) {
        problems.push(
          `version ${version}: retained bytes drifted (declared digest ${digest}, actual ${actual})`,
        );
      }
    }
    // The active catalog file must still be the current declared version's
    // bytes. A retired-but-retained skill (no top-level SKILL.md) keeps its
    // history resolvable; only a PRESENT file that disagrees is drift.
    const activeFile = join(skillRoot, 'SKILL.md');
    if (existsSync(activeFile)) {
      const activeDigest = skillSourceHash(readFileSync(activeFile, 'utf8'));
      const declaredCurrent = manifest.versions[manifest.currentVersion]!.digest;
      if (activeDigest !== declaredCurrent) {
        problems.push(
          `top-level SKILL.md no longer matches declared current version ${manifest.currentVersion} ` +
            `(declared digest ${declaredCurrent}, actual ${activeDigest}) — ship a new version instead of editing in place`,
        );
      }
    }
    results.push(
      problems.length > 0
        ? { skillId, status: 'invalid', problems }
        : {
            skillId,
            status: 'ok',
            currentVersion: manifest.currentVersion,
            versions: Object.keys(manifest.versions).sort(),
          },
    );
  }
  return results;
}

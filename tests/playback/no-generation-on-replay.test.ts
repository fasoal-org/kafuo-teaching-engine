/**
 * FR-023 / AS-005: replaying a lesson never issues a paid speech request.
 * Web playback only plays stored audio (or browser speech of the original
 * text); no playback module may reach the synthesis route or the provider.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const PLAYBACK = ['lib/playback', 'lib/utils/audio-player.ts', 'lib/action/engine.ts', 'lib/media/resolve-audio-bytes.ts'];

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name))).filter((f) => /\.(ts|tsx)$/.test(f));
}

describe('no generation on replay (FR-023)', () => {
  it.each(PLAYBACK)('%s never calls the TTS route or the provider', (path) => {
    for (const file of files(path)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\/api\/generate\/tts/);
      expect(text, file).not.toMatch(/\bgenerateTTS\b|generateAndStoreTTS|synthesizeNarration/);
    }
  });
});

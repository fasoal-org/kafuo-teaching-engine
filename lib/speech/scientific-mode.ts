/**
 * Browser-side SATTS gate: true only when the server reported `shadow`/`on`
 * (`/api/server-providers` → `speech.scientificMode`). Absent or unknown means
 * off, so every request and surface stays exactly as today.
 */
export function isScientificSpeechActive(mode: unknown): boolean {
  return mode === 'on' || mode === 'shadow';
}

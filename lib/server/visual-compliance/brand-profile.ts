import type { MoeBrandProfile } from './types';

/**
 * The default MOE brand profile. Deployments override it per tenant /
 * curriculum with `MOE_BRAND_PROFILE_JSON` (a JSON `MoeBrandProfile`); the
 * profile must be reviewed by the curriculum owner before production use.
 */
export const DEFAULT_MOE_BRAND_PROFILE: MoeBrandProfile = {
  id: 'moe-default-v1',
  names: [
    'وزارة التربية والتعليم',
    'وزارة التعليم',
    'وزارة التربية',
    'Ministry of Education',
    'Ministry of Education and Higher Education',
    'MOE',
  ],
  watermarkPhrases: [
    'حقوق الطبع محفوظة لوزارة التربية والتعليم',
    'حقوق الطبع محفوظة لوزارة التعليم',
    'Property of the Ministry of Education',
    '© Ministry of Education',
  ],
};

function isProfile(value: unknown): value is MoeBrandProfile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const strings = (input: unknown) =>
    Array.isArray(input) && input.every((item) => typeof item === 'string');
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    strings(record.names) &&
    strings(record.watermarkPhrases) &&
    (record.referenceImages === undefined || strings(record.referenceImages))
  );
}

/** The active profile: the configured override when valid, else the default. */
export function resolveMoeBrandProfile(env: NodeJS.ProcessEnv = process.env): MoeBrandProfile {
  const raw = env.MOE_BRAND_PROFILE_JSON;
  if (!raw) return DEFAULT_MOE_BRAND_PROFILE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isProfile(parsed)) return parsed;
  } catch {
    // fall through — an unreadable override never silently disables screening
  }
  return DEFAULT_MOE_BRAND_PROFILE;
}

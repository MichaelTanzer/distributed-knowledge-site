/**
 * Edge-safe v4 switch (no Node imports): used by middleware.ts and lib/v4Staging.ts.
 *
 * v4 is enabled only when BOTH DK_V4_STAGING_URL and DK_V4_STAGING_TOKEN are set (non-empty after trimming),
 * in any Vercel environment. Neither set: v3 fallback. Exactly one set: also the v3 fallback, and a
 * server-side warning `v4_partial_config` naming the variables (never their values) is logged once per
 * server instance.
 */

const URL_VAR = 'DK_V4_STAGING_URL';
const TOKEN_VAR = 'DK_V4_STAGING_TOKEN';

export type V4Config = 'enabled' | 'disabled' | 'partial';

let partialWarned = false;

function isSet(value: string | undefined): boolean {
  return (value ?? '').trim() !== '';
}

export function v4ConfigState(): V4Config {
  // Static member access (not process.env[name]) so the edge middleware bundle reads them at runtime.
  const url = isSet(process.env.DK_V4_STAGING_URL);
  const token = isSet(process.env.DK_V4_STAGING_TOKEN);
  if (url && token) return 'enabled';
  if (!url && !token) return 'disabled';
  if (!partialWarned) {
    partialWarned = true;
    console.warn(
      JSON.stringify({
        event: 'v4_partial_config',
        set: url ? [URL_VAR] : [TOKEN_VAR],
        missing: url ? [TOKEN_VAR] : [URL_VAR],
        effect: 'v4 disabled; /generate serves the v3 form'
      })
    );
  }
  return 'partial';
}

/** True only when both DK_V4_* variables are set (Production or Preview). */
export function v4Enabled(): boolean {
  return v4ConfigState() === 'enabled';
}

/** The operator page and operator views (budget figures) exist only on Vercel Preview deployments. */
export function operatorPreview(): boolean {
  return process.env.VERCEL_ENV === 'preview';
}

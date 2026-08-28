/**
 * `agy` and `antigravity` are one provider: same Cloud Code backend, same executor,
 * same OAuth client, same accounts. `agy` is the canonical id; `antigravity` is kept
 * as a routing alias so stored connections, `antigravity/<model>` refs, shipped combo
 * presets and `omniroute login antigravity` continue to resolve.
 */
export const ANTIGRAVITY_CANONICAL_PROVIDER_ID = "agy";
export const ANTIGRAVITY_LEGACY_PROVIDER_ID = "antigravity";

export const ANTIGRAVITY_FAMILY_PROVIDER_IDS: readonly string[] = Object.freeze([
  ANTIGRAVITY_CANONICAL_PROVIDER_ID,
  ANTIGRAVITY_LEGACY_PROVIDER_ID,
]);

export function isAntigravityFamilyProvider(provider: unknown): boolean {
  return (
    provider === ANTIGRAVITY_CANONICAL_PROVIDER_ID || provider === ANTIGRAVITY_LEGACY_PROVIDER_ID
  );
}

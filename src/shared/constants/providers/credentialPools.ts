/**
 * Providers that authenticate against the SAME upstream account and therefore must draw
 * on one connection pool. Keeping them separate tracks two quota/cooldown pools against a
 * single real quota, so a 429 seen by one is invisible to the other.
 *
 * This is deliberately NOT an alias: the members stay distinct providers because they
 * differ in request presets or catalogs. Only credentials and quota accounting are shared.
 */
export const SHARED_CREDENTIAL_POOLS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["nvidia", "nvidia_nim"]),
  // Same z.ai coding-plan key and endpoint; `glmt` only differs by its thinking preset.
  Object.freeze(["glm", "glmt"]),
]);

/**
 * Connection-lookup order for a provider that shares credentials with others: the
 * requested provider first, then its pool siblings. Returns null when it shares nothing.
 */
export function getSharedCredentialPool(provider: string): string[] | null {
  for (const group of SHARED_CREDENTIAL_POOLS) {
    if (group.includes(provider)) {
      return [provider, ...group.filter((member) => member !== provider)];
    }
  }
  return null;
}

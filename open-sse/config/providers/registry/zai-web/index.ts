import type { RegistryEntry } from "../../shared.ts";

export const zai_webProvider: RegistryEntry = {
  id: "zai-web",
  alias: "zw",
  format: "openai",
  executor: "zai-web",
  // Free consumer web chat at chat.z.ai (Zhipu AI). Guest tokens are minted
  // automatically (no account); a pasted chat.z.ai Cookie unlocks the higher
  // model tiers. See `open-sse/executors/zai-web.ts` for the wire format.
  // Distinct from the API-key `zai`/`glm` providers (api.z.ai).
  baseUrl: "https://chat.z.ai",
  authType: "apikey",
  authHeader: "cookie",
  models: [
    // Guest-tier default (only model the anonymous token can reach).
    { id: "glm-4.7", name: "GLM-4.7" },
    // Registered-account tiers (require a pasted chat.z.ai Cookie). Casing is
    // significant: z.ai returns 500 for the wrong case.
    { id: "GLM-5.1", name: "GLM-5.1" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "GLM-5-Turbo", name: "GLM-5-Turbo" },
    { id: "0727-360B-API", name: "GLM-4.5" },
    { id: "0727-106B-API", name: "GLM-4.5-Air" },
  ],
};

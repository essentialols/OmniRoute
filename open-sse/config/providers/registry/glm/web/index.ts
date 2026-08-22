import type { RegistryEntry } from "../../../shared.ts";

/**
 * glm-web: FREE GLM (Zhipu 智谱清言) via the chatglm.cn consumer webchat.
 *
 * NOT the paid api.z.ai / bigmodel.cn API-key path used by `glm`/`glmt`/`glm-cn`.
 * The GlmWebExecutor auto-mints a ~24h guest token (no account needed) and signs
 * every request; an optional chatglm.cn refresh_token raises the rate limits.
 * `authType: none` because the baseline path requires zero credentials.
 *
 * Every `chatglm-*` id maps to the same default GLM assistant at the webchat
 * layer (the model-name distinction is cosmetic); a raw 24-hex assistant id is
 * passed through verbatim to target a custom assistant.
 */
export const glm_webProvider: RegistryEntry = {
  id: "glm-web",
  alias: "glm-web",
  format: "openai",
  executor: "glm-web",
  baseUrl: "https://chatglm.cn/chatglm/backend-api/assistant/stream",
  authType: "none",
  authHeader: "none",
  defaultContextLength: 128000,
  models: [
    { id: "chatglm-5.1", name: "GLM-5.1 (chatglm.cn Free)" },
    { id: "chatglm-5", name: "GLM-5 (chatglm.cn Free)" },
    { id: "chatglm-4.7", name: "GLM-4.7 (chatglm.cn Free)" },
    { id: "chatglm-4.6", name: "GLM-4.6 (chatglm.cn Free)" },
    { id: "chatglm-4", name: "GLM-4 (chatglm.cn Free)" },
    {
      id: "chatglm-5.1-think",
      name: "GLM-5.1 Thinking (chatglm.cn Free)",
      supportsReasoning: true,
    },
  ],
};

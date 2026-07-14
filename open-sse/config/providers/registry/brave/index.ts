import type { RegistryEntry } from "../../shared.ts";

/**
 * Brave Leo: Brave browser's built-in AI assistant, served natively by the
 * BraveLeoExecutor (open-sse/executors/brave-leo.ts) directly against the Brave
 * Services Gateway (ai-chat.bsg.brave.com). No sidecar / shared-relay-proxy.
 *
 * Auth is anonymous: the executor HMAC-signs each request with public keys
 * extracted from the Brave desktop binary (via resolvePublicCred). No Brave
 * account or user API key is required, so authType is "none".
 *
 * Model ids match the CCR / former shared-relay-proxy aliases (`brave-*`); the
 * executor maps them to the Brave upstream ids (e.g. brave-haiku to
 * claude-3-haiku). The `claude-brave-*` CCR shortcut is also accepted by the
 * executor and normalized to `brave-*`.
 */
export const braveProvider: RegistryEntry = {
  id: "brave",
  format: "openai",
  executor: "brave",
  baseUrl: "https://ai-chat.bsg.brave.com/v1",
  baseUrls: ["https://ai-chat.bsg.brave.com/v1"],
  authType: "none",
  authHeader: "none",
  defaultContextLength: 32000,
  models: [
    { id: "brave-haiku", name: "Claude 3 Haiku (Brave Leo)", contextLength: 200000 },
    { id: "brave-glm-5-1", name: "GLM 5.1 (Brave Leo)", contextLength: 128000 },
    { id: "brave-maverick", name: "Llama 4 Maverick (Brave Leo)", contextLength: 128000 },
    { id: "brave-qwen-235b", name: "Qwen 3 235B (Brave Leo)", contextLength: 128000 },
    { id: "brave-glm-flash", name: "GLM 4.7 Flash (Brave Leo)", contextLength: 128000 },
    { id: "brave-gpt-oss", name: "GPT-OSS 20B (Brave Leo)", contextLength: 128000 },
    { id: "brave-llama-8b", name: "Llama 3.1 8B (Brave Leo)", contextLength: 16000 },
  ],
};

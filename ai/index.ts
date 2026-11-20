export { AIGateway, createAIGateway } from "./gateway.js";
export { AIError } from "./errors.js";
export {
  OpenAICompatibleAdapter,
  ZAI_CHAT_COMPLETIONS_ENDPOINT,
  createZaiProviderConfig,
  validateAIEndpoint,
} from "./providers/openai-compatible.js";
export type {
  AIAdapterRequest,
  AIAdapterResult,
  AIFetch,
  AIGenerateRequest,
  AIMessage,
  AIMessageRole,
  AIProposal,
  AIProviderAdapter,
  AIProviderConfig,
  AISecretStore,
  AIUsage,
} from "./types.js";
export type { AIErrorCode } from "./errors.js";

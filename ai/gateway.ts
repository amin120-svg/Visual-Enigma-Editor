import { AIError } from "./errors.js";
import { OpenAICompatibleAdapter } from "./providers/openai-compatible.js";
import type {
  AIProviderAdapter,
  AIProviderConfig,
  AIGenerateRequest,
  AIProposal,
  AISecretStore,
  AIFetch,
} from "./types.js";

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 500_000;

export interface AIGatewayOptions {
  providers: readonly AIProviderConfig[];
  secretStore: AISecretStore;
  /** Injected in tests. In production this is the main-process fetch. */
  fetchImpl?: AIFetch;
  additionalAdapters?: readonly AIProviderAdapter[];
}

function validateRequest(request: AIGenerateRequest): void {
  if (!request.providerId || !Array.isArray(request.messages) ||
      request.messages.length === 0 || request.messages.length > MAX_MESSAGES) {
    throw new AIError("invalid_request", "AI request must contain messages and a provider.");
  }
  let totalChars = 0;
  for (const message of request.messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim()) {
      throw new AIError("invalid_request", "AI request contains an invalid message.");
    }
    totalChars += message.content.length;
  }
  if (totalChars > MAX_MESSAGE_CHARS) {
    throw new AIError("invalid_request", "AI request is too large.");
  }
  if (request.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(request.maxOutputTokens) ||
       request.maxOutputTokens < 1 || request.maxOutputTokens > 131_072)) {
    throw new AIError("invalid_request", "AI output token limit is invalid.");
  }
  if (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
       request.temperature < 0 || request.temperature > 2)) {
    throw new AIError("invalid_request", "AI temperature is invalid.");
  }
}

function validateProvider(provider: AIProviderConfig): void {
  if (!provider.id?.trim() || !provider.kind?.trim() ||
      !provider.model?.trim() || !provider.secretRef?.trim() ||
      !provider.displayName?.trim() || !provider.endpoint?.trim()) {
    throw new AIError("invalid_configuration", "AI provider configuration is incomplete.");
  }
}

/** No file-write, shell, deployment or auto-apply method exists on this gateway. */
export class AIGateway {
  private readonly providers = new Map<string, Readonly<AIProviderConfig>>();
  private readonly adapters = new Map<string, AIProviderAdapter>();

  constructor(private readonly options: AIGatewayOptions) {
    for (const provider of options.providers) {
      validateProvider(provider);
      if (this.providers.has(provider.id)) {
        throw new AIError("invalid_configuration", "Duplicate AI provider ID.");
      }
      this.providers.set(provider.id, { ...provider });
    }
    const adapters = [
      new OpenAICompatibleAdapter(options.fetchImpl),
      ...(options.additionalAdapters ?? []),
    ];
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new AIError("invalid_configuration", "Duplicate AI adapter kind.");
      }
      this.adapters.set(adapter.kind, adapter);
    }
  }

  async generate(request: AIGenerateRequest): Promise<AIProposal> {
    validateRequest(request);
    const provider = this.providers.get(request.providerId);
    if (!provider) {
      throw new AIError("invalid_configuration", "AI provider is not configured.");
    }
    const adapter = this.adapters.get(provider.kind);
    if (!adapter) {
      throw new AIError("unsupported_provider", "AI provider adapter is unavailable.");
    }
    let apiKey: string | null;
    try {
      apiKey = await this.options.secretStore.getSecret(provider.secretRef);
    } catch {
      // Credential-store errors can contain implementation details. Do not
      // forward their raw text to the renderer or a log sink.
      throw new AIError("missing_secret", "Could not retrieve AI provider API key.");
    }
    if (!apiKey?.trim()) {
      throw new AIError("missing_secret", "AI provider API key is not configured.");
    }
    const result = await adapter.generate({
      provider,
      apiKey,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      signal: request.signal,
    });
    if (typeof result.text !== "string" || !result.text.trim()) {
      throw new AIError("invalid_response", "AI provider returned no text.");
    }
    return Object.freeze({
      id: globalThis.crypto.randomUUID(),
      providerId: provider.id,
      model: provider.model,
      text: result.text,
      createdAt: new Date().toISOString(),
      usage: result.usage,
      requiresExplicitApproval: true as const,
    });
  }
}

export function createAIGateway(options: AIGatewayOptions): AIGateway {
  return new AIGateway(options);
}

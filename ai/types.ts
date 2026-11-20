/** AI output is always a proposal. Applying it is a separate, user-approved action. */
export type AIMessageRole = "system" | "user" | "assistant";

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

/**
 * Store only a reference in settings. The implementation belongs in the
 * desktop main process and should use an operating-system credential vault.
 */
export interface AISecretStore {
  getSecret(secretRef: string): Promise<string | null>;
}

export interface AIProviderConfig {
  id: string;
  kind: string;
  displayName: string;
  model: string;
  secretRef: string;
  /** Exact chat-completions URL; never sourced from project code or AI output. */
  endpoint: string;
  /** Only for an explicitly configured local development provider. */
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
}

export interface AIGenerateRequest {
  providerId: string;
  messages: readonly AIMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIProposal {
  id: string;
  providerId: string;
  model: string;
  text: string;
  createdAt: string;
  usage?: AIUsage;
  /** Callers must preview and explicitly approve any later file or deploy action. */
  requiresExplicitApproval: true;
}

export interface AIAdapterRequest {
  provider: Readonly<AIProviderConfig>;
  apiKey: string;
  messages: readonly AIMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AIAdapterResult {
  text: string;
  usage?: AIUsage;
}

export interface AIProviderAdapter {
  readonly kind: string;
  generate(request: AIAdapterRequest): Promise<AIAdapterResult>;
}

export type AIFetch = (input: string, init: RequestInit) => Promise<Response>;

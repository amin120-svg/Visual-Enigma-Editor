import { AIError } from "../errors.js";
import type {
  AIAdapterRequest,
  AIAdapterResult,
  AIFetch,
  AIProviderAdapter,
  AIProviderConfig,
  AIUsage,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_RESPONSE_CHARS = 8_000_000;
const MAX_RESPONSE_BYTES = 8_000_000;

export const ZAI_CHAT_COMPLETIONS_ENDPOINT =
  "https://api.z.ai/api/paas/v4/chat/completions";

export function createZaiProviderConfig(input: {
  model: string;
  secretRef: string;
  id?: string;
  endpoint?: string;
  timeoutMs?: number;
}): AIProviderConfig {
  return {
    id: input.id ?? "zai",
    kind: "openai-compatible",
    displayName: "Z.ai",
    model: input.model,
    secretRef: input.secretRef,
    endpoint: input.endpoint ?? ZAI_CHAT_COMPLETIONS_ENDPOINT,
    timeoutMs: input.timeoutMs,
  };
}

/** Validate settings supplied by the user, never URLs supplied by a project or model. */
export function validateAIEndpoint(provider: AIProviderConfig): URL {
  let url: URL;
  try {
    url = new URL(provider.endpoint);
  } catch {
    throw new AIError("invalid_configuration", "AI provider endpoint is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AIError(
      "invalid_configuration",
      "AI endpoint must not contain credentials, query parameters or a fragment.",
    );
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const localHttp =
    url.protocol === "http:" &&
    provider.allowInsecureLocalhost === true &&
    localHosts.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !localHttp) {
    throw new AIError(
      "invalid_configuration",
      "AI endpoint must use HTTPS (or explicitly allowed loopback HTTP).",
    );
  }
  if (!url.pathname || url.pathname === "/") {
    throw new AIError("invalid_configuration", "AI endpoint path is missing.");
  }
  return url;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return undefined;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds)));
}

function parseUsage(value: unknown): AIUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const positiveInteger = (item: unknown): number | undefined =>
    typeof item === "number" && Number.isSafeInteger(item) && item >= 0
      ? item
      : undefined;
  const usage: AIUsage = {
    inputTokens: positiveInteger(input.prompt_tokens),
    outputTokens: positiveInteger(input.completion_tokens),
    totalTokens: positiveInteger(input.total_tokens),
  };
  return Object.values(usage).some((item) => item !== undefined)
    ? usage
    : undefined;
}

function parseText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (!part || typeof part !== "object") return null;
    const item = part as Record<string, unknown>;
    if (item.type !== "text" || typeof item.text !== "string") return null;
    parts.push(item.text);
  }
  return parts.join("");
}

async function readLimitedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AIError("invalid_response", "AI provider response is too large.");
  }

  // Production fetch responses expose a stream. Some injected test responses
  // expose only text(); the fallback is checked after reading by necessity.
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new AIError("invalid_response", "AI provider response is too large.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        throw new AIError("invalid_response", "AI provider response is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly kind = "openai-compatible";

  constructor(private readonly fetchImpl: AIFetch = globalThis.fetch) {}

  async generate(request: AIAdapterRequest): Promise<AIAdapterResult> {
    const endpoint = validateAIEndpoint(request.provider);
    const timeoutMs = request.provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new AIError("invalid_configuration", "AI provider timeout is invalid.");
    }

    const controller = new AbortController();
    let timedOut = false;
    const onCancel = () => controller.abort();
    request.signal?.addEventListener("abort", onCancel, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(endpoint.href, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.provider.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AIError(
          "rate_limited",
          "AI provider rate limit reached. Try again later.",
          429,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }
      if (!response.ok) {
        // Do not include provider response bodies: they can echo prompts or secrets.
        throw new AIError(
          "provider_error",
          `AI provider rejected the request (HTTP ${response.status}).`,
          response.status,
        );
      }

      let raw: string;
      try {
        raw = await readLimitedResponseText(response);
      } catch (error) {
        if (error instanceof AIError) throw error;
        if (timedOut) {
          throw new AIError("timeout", "AI provider request timed out.");
        }
        if (request.signal?.aborted) {
          throw new AIError("cancelled", "AI provider request was cancelled.");
        }
        throw new AIError("invalid_response", "Could not read AI provider response.");
      }
      if (raw.length > MAX_RESPONSE_CHARS) {
        throw new AIError("invalid_response", "AI provider response is too large.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AIError("invalid_response", "AI provider returned invalid JSON.");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new AIError("invalid_response", "AI provider response is incomplete.");
      }
      const body = parsed as Record<string, unknown>;
      const choices = body.choices;
      if (!Array.isArray(choices) || !choices.length) {
        throw new AIError("invalid_response", "AI provider returned no choices.");
      }
      const choice = choices[0] as Record<string, unknown> | null;
      if (choice?.finish_reason === "length") {
        throw new AIError("invalid_response", "AI output was truncated. Request a smaller change or increase the output limit.");
      }
      if (choice?.finish_reason === "content_filter" || choice?.finish_reason === "tool_calls") {
        throw new AIError("invalid_response", "AI provider did not return a complete text replacement.");
      }
      const message = choice?.message as Record<string, unknown> | undefined;
      const text = parseText(message?.content);
      if (!text?.trim()) {
        throw new AIError("invalid_response", "AI provider returned no text.");
      }
      return { text, usage: parseUsage(body.usage) };
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (timedOut) {
        throw new AIError("timeout", "AI provider request timed out.");
      }
      if (request.signal?.aborted) {
        throw new AIError("cancelled", "AI provider request was cancelled.");
      }
      // Network exception messages may contain sensitive URL or proxy details.
      throw new AIError("transport_error", "Could not connect to AI provider.");
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onCancel);
    }
  }
}

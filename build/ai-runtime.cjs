var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ai/index.ts
var index_exports = {};
__export(index_exports, {
  AIError: () => AIError,
  AIGateway: () => AIGateway,
  OpenAICompatibleAdapter: () => OpenAICompatibleAdapter,
  ZAI_CHAT_COMPLETIONS_ENDPOINT: () => ZAI_CHAT_COMPLETIONS_ENDPOINT,
  createAIGateway: () => createAIGateway,
  createZaiProviderConfig: () => createZaiProviderConfig,
  validateAIEndpoint: () => validateAIEndpoint
});
module.exports = __toCommonJS(index_exports);

// ai/errors.ts
var AIError = class extends Error {
  constructor(code, message, status, retryAfterMs) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.name = "AIError";
  }
  code;
  status;
  retryAfterMs;
};

// ai/providers/openai-compatible.ts
var DEFAULT_TIMEOUT_MS = 6e4;
var MAX_TIMEOUT_MS = 3e5;
var MAX_RETRY_AFTER_MS = 864e5;
var MAX_RESPONSE_CHARS = 8e6;
var MAX_RESPONSE_BYTES = 8e6;
var ZAI_CHAT_COMPLETIONS_ENDPOINT = "https://api.z.ai/api/paas/v4/chat/completions";
function createZaiProviderConfig(input) {
  return {
    id: input.id ?? "zai",
    kind: "openai-compatible",
    displayName: "Z.ai",
    model: input.model,
    secretRef: input.secretRef,
    endpoint: input.endpoint ?? ZAI_CHAT_COMPLETIONS_ENDPOINT,
    timeoutMs: input.timeoutMs
  };
}
function validateAIEndpoint(provider) {
  let url;
  try {
    url = new URL(provider.endpoint);
  } catch {
    throw new AIError("invalid_configuration", "AI provider endpoint is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AIError(
      "invalid_configuration",
      "AI endpoint must not contain credentials, query parameters or a fragment."
    );
  }
  const localHosts = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
  const localHttp = url.protocol === "http:" && provider.allowInsecureLocalhost === true && localHosts.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !localHttp) {
    throw new AIError(
      "invalid_configuration",
      "AI endpoint must use HTTPS (or explicitly allowed loopback HTTP)."
    );
  }
  if (!url.pathname || url.pathname === "/") {
    throw new AIError("invalid_configuration", "AI endpoint path is missing.");
  }
  return url;
}
function parseRetryAfter(value) {
  if (!value) return void 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1e3 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return void 0;
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds)));
}
function parseUsage(value) {
  if (!value || typeof value !== "object") return void 0;
  const input = value;
  const positiveInteger = (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : void 0;
  const usage = {
    inputTokens: positiveInteger(input.prompt_tokens),
    outputTokens: positiveInteger(input.completion_tokens),
    totalTokens: positiveInteger(input.total_tokens)
  };
  return Object.values(usage).some((item) => item !== void 0) ? usage : void 0;
}
function parseText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = [];
  for (const part of value) {
    if (!part || typeof part !== "object") return null;
    const item = part;
    if (item.type !== "text" || typeof item.text !== "string") return null;
    parts.push(item.text);
  }
  return parts.join("");
}
async function readLimitedResponseText(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AIError("invalid_response", "AI provider response is too large.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text2 = await response.text();
    if (new TextEncoder().encode(text2).byteLength > MAX_RESPONSE_BYTES) {
      throw new AIError("invalid_response", "AI provider response is too large.");
    }
    return text2;
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
    await reader.cancel().catch(() => {
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}
var OpenAICompatibleAdapter = class {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }
  fetchImpl;
  kind = "openai-compatible";
  async generate(request) {
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
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: request.provider.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          stream: false
        }),
        signal: controller.signal
      });
      if (response.status === 429) {
        throw new AIError(
          "rate_limited",
          "AI provider rate limit reached. Try again later.",
          429,
          parseRetryAfter(response.headers.get("Retry-After"))
        );
      }
      if (!response.ok) {
        throw new AIError(
          "provider_error",
          `AI provider rejected the request (HTTP ${response.status}).`,
          response.status
        );
      }
      let raw;
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
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new AIError("invalid_response", "AI provider returned invalid JSON.");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new AIError("invalid_response", "AI provider response is incomplete.");
      }
      const body = parsed;
      const choices = body.choices;
      if (!Array.isArray(choices) || !choices.length) {
        throw new AIError("invalid_response", "AI provider returned no choices.");
      }
      const choice = choices[0];
      if (choice?.finish_reason === "length") {
        throw new AIError("invalid_response", "AI output was truncated. Request a smaller change or increase the output limit.");
      }
      if (choice?.finish_reason === "content_filter" || choice?.finish_reason === "tool_calls") {
        throw new AIError("invalid_response", "AI provider did not return a complete text replacement.");
      }
      const message = choice?.message;
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
      throw new AIError("transport_error", "Could not connect to AI provider.");
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onCancel);
    }
  }
};

// ai/gateway.ts
var MAX_MESSAGES = 100;
var MAX_MESSAGE_CHARS = 5e5;
function validateRequest(request) {
  if (!request.providerId || !Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > MAX_MESSAGES) {
    throw new AIError("invalid_request", "AI request must contain messages and a provider.");
  }
  let totalChars = 0;
  for (const message of request.messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim()) {
      throw new AIError("invalid_request", "AI request contains an invalid message.");
    }
    totalChars += message.content.length;
  }
  if (totalChars > MAX_MESSAGE_CHARS) {
    throw new AIError("invalid_request", "AI request is too large.");
  }
  if (request.maxOutputTokens !== void 0 && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 131072)) {
    throw new AIError("invalid_request", "AI output token limit is invalid.");
  }
  if (request.temperature !== void 0 && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw new AIError("invalid_request", "AI temperature is invalid.");
  }
}
function validateProvider(provider) {
  if (!provider.id?.trim() || !provider.kind?.trim() || !provider.model?.trim() || !provider.secretRef?.trim() || !provider.displayName?.trim() || !provider.endpoint?.trim()) {
    throw new AIError("invalid_configuration", "AI provider configuration is incomplete.");
  }
}
var AIGateway = class {
  constructor(options) {
    this.options = options;
    for (const provider of options.providers) {
      validateProvider(provider);
      if (this.providers.has(provider.id)) {
        throw new AIError("invalid_configuration", "Duplicate AI provider ID.");
      }
      this.providers.set(provider.id, { ...provider });
    }
    const adapters = [
      new OpenAICompatibleAdapter(options.fetchImpl),
      ...options.additionalAdapters ?? []
    ];
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new AIError("invalid_configuration", "Duplicate AI adapter kind.");
      }
      this.adapters.set(adapter.kind, adapter);
    }
  }
  options;
  providers = /* @__PURE__ */ new Map();
  adapters = /* @__PURE__ */ new Map();
  async generate(request) {
    validateRequest(request);
    const provider = this.providers.get(request.providerId);
    if (!provider) {
      throw new AIError("invalid_configuration", "AI provider is not configured.");
    }
    const adapter = this.adapters.get(provider.kind);
    if (!adapter) {
      throw new AIError("unsupported_provider", "AI provider adapter is unavailable.");
    }
    let apiKey;
    try {
      apiKey = await this.options.secretStore.getSecret(provider.secretRef);
    } catch {
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
      signal: request.signal
    });
    if (typeof result.text !== "string" || !result.text.trim()) {
      throw new AIError("invalid_response", "AI provider returned no text.");
    }
    return Object.freeze({
      id: globalThis.crypto.randomUUID(),
      providerId: provider.id,
      model: provider.model,
      text: result.text,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      usage: result.usage,
      requiresExplicitApproval: true
    });
  }
};
function createAIGateway(options) {
  return new AIGateway(options);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AIError,
  AIGateway,
  OpenAICompatibleAdapter,
  ZAI_CHAT_COMPLETIONS_ENDPOINT,
  createAIGateway,
  createZaiProviderConfig,
  validateAIEndpoint
});

import { AIError } from "./errors.js";
import { createAIGateway } from "./gateway.js";
import {
  createZaiProviderConfig,
  validateAIEndpoint,
} from "./providers/openai-compatible.js";
import type { AIFetch, AISecretStore } from "./types.js";

function assert(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(`AI gateway test failed: ${description}`);
}

async function expectCode(operation: () => Promise<unknown>, code: string): Promise<AIError> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof AIError, `expected AIError (${code})`);
    assert(error.code === code, `expected ${code}, got ${error.code}`);
    return error;
  }
  throw new Error(`AI gateway test failed: expected ${code}`);
}

const provider = createZaiProviderConfig({
  model: "glm-4.7-flash",
  secretRef: "vault:zai-test",
});
const messages = [{ role: "user" as const, content: "Create a header" }];

/** Self-contained tests; a package-level runner can call this function. */
export async function runAIGatewayTests(): Promise<void> {
  const testSecret = globalThis.crypto.randomUUID();
  const secretStore: AISecretStore = {
    async getSecret(reference) {
      assert(reference === "vault:zai-test", "uses secret reference, not plaintext config");
      return testSecret;
    },
  };
  let requestCount = 0;
  const successFetch: AIFetch = async (url, init) => {
    requestCount += 1;
    assert(url === provider.endpoint, "uses configured endpoint");
    assert(init.redirect === "error", "does not follow provider redirects");
    assert(
      new Headers(init.headers).get("Authorization") === `Bearer ${testSecret}`,
      "sends vault key only in authorization header",
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert(body.model === provider.model, "uses selected model");
    assert(body.stream === false, "does not stream tool actions");
    assert(!("tools" in body), "does not offer tools to execute");
    return new Response(JSON.stringify({
      choices: [{ message: { content: "<header>Proposed</header>" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200 });
  };
  const gateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: successFetch });
  const proposal = await gateway.generate({ providerId: provider.id, messages });
  assert(requestCount === 1, "makes one request");
  assert(proposal.text === "<header>Proposed</header>", "returns proposed text");
  assert(proposal.requiresExplicitApproval, "requires user approval");
  assert(proposal.usage?.totalTokens === 15, "returns usage");
  assert(!("apply" in gateway) && !("execute" in gateway), "has no apply or execution API");
  assert(!JSON.stringify(proposal).includes(testSecret), "never exposes key in proposal");

  const truncatedFetch: AIFetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { content: "<header>Incomplete" } }],
  }), { status: 200 });
  const truncatedGateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: truncatedFetch });
  await expectCode(
    () => truncatedGateway.generate({ providerId: provider.id, messages }),
    "invalid_response",
  );

  const redirectFetch: AIFetch = async (_url, init) => {
    assert(init.redirect === "error", "redirect policy is passed to fetch");
    return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/chat" } });
  };
  const redirectGateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: redirectFetch });
  await expectCode(
    () => redirectGateway.generate({ providerId: provider.id, messages }),
    "provider_error",
  );

  let streamCancelled = false;
  const oversizedFetch: AIFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8_000_001)); },
    cancel() { streamCancelled = true; },
  }), { status: 200 });
  const oversizedGateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: oversizedFetch });
  await expectCode(
    () => oversizedGateway.generate({ providerId: provider.id, messages }),
    "invalid_response",
  );
  assert(streamCancelled, "cancels an oversized response stream");

  const textOnlyFetch: AIFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => JSON.stringify({ choices: [{ message: { content: "Fallback works" } }] }),
  }) as Response;
  const textOnlyGateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: textOnlyFetch });
  const textOnlyProposal = await textOnlyGateway.generate({ providerId: provider.id, messages });
  assert(textOnlyProposal.text === "Fallback works", "supports text-only mocked responses");

  const oversizedTextOnlyFetch: AIFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => "x".repeat(8_000_001),
  }) as Response;
  const oversizedTextOnlyGateway = createAIGateway({
    providers: [provider], secretStore, fetchImpl: oversizedTextOnlyFetch,
  });
  await expectCode(
    () => oversizedTextOnlyGateway.generate({ providerId: provider.id, messages }),
    "invalid_response",
  );

  const rateFetch: AIFetch = async () => new Response(testSecret, {
    status: 429,
    headers: { "Retry-After": "2" },
  });
  const rateGateway = createAIGateway({ providers: [provider], secretStore, fetchImpl: rateFetch });
  const rateError = await expectCode(
    () => rateGateway.generate({ providerId: provider.id, messages }),
    "rate_limited",
  );
  assert(rateError.retryAfterMs === 2_000, "parses retry-after");
  assert(!rateError.message.includes(testSecret), "does not expose response body");

  const missingGateway = createAIGateway({
    providers: [provider],
    secretStore: { async getSecret() { return null; } },
    fetchImpl: successFetch,
  });
  await expectCode(
    () => missingGateway.generate({ providerId: provider.id, messages }),
    "missing_secret",
  );
  const failedStoreGateway = createAIGateway({
    providers: [provider],
    secretStore: { async getSecret() { throw new Error(testSecret); } },
    fetchImpl: successFetch,
  });
  const storeError = await expectCode(
    () => failedStoreGateway.generate({ providerId: provider.id, messages }),
    "missing_secret",
  );
  assert(!storeError.message.includes(testSecret), "sanitizes vault errors");

  const timeoutFetch: AIFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const timeoutGateway = createAIGateway({
    providers: [{ ...provider, timeoutMs: 5 }], secretStore, fetchImpl: timeoutFetch,
  });
  await expectCode(
    () => timeoutGateway.generate({ providerId: provider.id, messages }),
    "timeout",
  );

  let invalidEndpoint = false;
  try {
    validateAIEndpoint({ ...provider, endpoint: "http://example.com/chat/completions" });
  } catch (error) {
    invalidEndpoint = error instanceof AIError && error.code === "invalid_configuration";
  }
  assert(invalidEndpoint, "rejects insecure remote endpoint");
}

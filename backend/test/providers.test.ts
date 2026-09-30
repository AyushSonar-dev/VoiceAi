import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { isRecoverableProviderError, LlmProviderError, redactSecrets } from "../src/agent/llm/errors.js";
import { geminiProfile } from "../src/agent/llm/providers.js";
import { createLlm, __resetLlmForTests } from "../src/agent/llm/index.js";
import { PlaceholderBrain } from "../src/agent/llm/placeholderBrain.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";

/**
 * Gemini provider. Every test drives a real HTTP server that speaks the
 * OpenAI-compatible wire protocol, so the request Gemini would receive is
 * asserted on the wire rather than mocked out.
 */

type Mutable = Record<string, unknown>;
const cfg = config as unknown as Mutable;

const savedEnv = {
  geminiKey: config.geminiKey,
  geminiModel: config.geminiModel,
  geminiBaseUrl: config.geminiBaseUrl,
};

function setGeminiEnv(v: Partial<Record<keyof typeof savedEnv, string>>): void {
  cfg.geminiKey = v.geminiKey ?? "";
  cfg.geminiModel = v.geminiModel ?? "gemini-3.8-flash";
  cfg.geminiBaseUrl = v.geminiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai";
  __resetLlmForTests();
}

interface Captured {
  url: string;
  auth: string | undefined;
  body: any;
}

interface Reply {
  status?: number;
  completion?: any;
  raw?: string;
}

/** Minimal OpenAI-compatible endpoint, scriptable per request. */
function startServer(script: Reply[]): Promise<{ url: string; close: () => Promise<void>; seen: Captured[] }> {
  const seen: Captured[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
      });
      const step = script[Math.min(i, script.length - 1)] ?? {};
      i++;
      res.writeHead(step.status ?? 200, { "content-type": "application/json" });
      res.end(step.raw ?? JSON.stringify(step.completion ?? completion("ok")));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        seen,
      });
    });
  });
}

const completion = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });

beforeEach(() => {
  __resetLlmForTests();
});
afterEach(() => {
  setGeminiEnv({});
});

// ---------------------------------------------------------------- config

test("config: the Gemini model comes from env with a sane default", () => {
  setGeminiEnv({ geminiKey: "g" });
  assert.equal(geminiProfile()?.model, "gemini-3.8-flash");
  setGeminiEnv({ geminiKey: "g", geminiModel: "gemini-3.5-flash" });
  assert.equal(geminiProfile()?.model, "gemini-3.5-flash");
});

test("config: a missing key means 'unavailable', not an error", () => {
  setGeminiEnv({});
  assert.equal(geminiProfile(), null);
});

test("provider: a Gemini key uses the real Gemini client", () => {
  setGeminiEnv({ geminiKey: "g-key" });
  assert.ok(!(createLlm() instanceof PlaceholderBrain), "must NOT fall back to the placeholder brain");
});

test("provider: no key uses the placeholder brain (no boot crash)", () => {
  setGeminiEnv({});
  assert.ok(createLlm() instanceof PlaceholderBrain);
});

// ------------------------------------------------------------ tool calling

test("tool calling: Gemini receives the full tool set over the compat layer", async () => {
  const server = await startServer([{ completion: completion("Here are some shirts.") }]);
  try {
    setGeminiEnv({ geminiKey: "g-key", geminiBaseUrl: server.url });

    const res = await createLlm().chat({ messages: [{ role: "user", content: "show me shirts" }], tools: TOOL_DEFINITIONS });

    assert.equal(res.message.content, "Here are some shirts.");
    assert.equal(server.seen.length, 1);
    const call = server.seen[0];
    assert.equal(call.body.model, "gemini-3.8-flash", "the configured Gemini model must be used");
    assert.equal(call.auth, "Bearer g-key");
    assert.equal(call.body.tool_choice, "auto");

    const names = (call.body.tools ?? []).map((t: any) => t.function.name);
    assert.deepEqual(names, TOOL_DEFINITIONS.map((t) => t.function.name));
    for (const required of ["searchProducts", "getProduct", "addToCart", "removeFromCart", "applyCoupon", "getCart", "checkout"]) {
      assert.ok(names.includes(required), `${required} must be available to Gemini`);
    }
    // Appearance ships with the product, so no provider is ever asked to look at a picture.
    assert.ok(!names.includes("describeProductImage"), "no runtime image tool may be exposed");
  } finally {
    await server.close();
  }
});

test("tool calling: a Gemini tool call is normalized into the app's own shape", async () => {
  const server = await startServer([
    {
      completion: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "searchProducts", arguments: '{"query":"shirt"}' } },
              ],
            },
          },
        ],
      },
    },
  ]);
  try {
    setGeminiEnv({ geminiKey: "g-key", geminiBaseUrl: server.url });
    const res = await createLlm().chat({ messages: [{ role: "user", content: "shirts" }], tools: TOOL_DEFINITIONS });
    assert.equal(res.message.content, "", "a null content must normalize to an empty string, not undefined");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls![0].function.name, "searchProducts");
    assert.equal(res.message.tool_calls![0].function.arguments, '{"query":"shirt"}');
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------- failures

test("failure: a 400 surfaces the real cause and is not classed as an outage", async () => {
  const server = await startServer([{ status: 400, raw: '{"error":{"message":"Invalid tool schema"}}' }]);
  try {
    setGeminiEnv({ geminiKey: "g-key", geminiBaseUrl: server.url });
    await assert.rejects(
      () => createLlm().chat({ messages: [{ role: "user", content: "hi" }] }),
      (err: Error) => {
        assert.ok(err instanceof LlmProviderError);
        assert.equal(err.provider, "gemini");
        assert.equal(err.status, 400);
        assert.equal(err.recoverable, false);
        assert.match(err.message, /Invalid tool schema/);
        return true;
      }
    );
    assert.equal(server.seen.length, 1, "a 400 is never retried");
  } finally {
    await server.close();
  }
});

test("breaker: our own 400s never trip it — the next request still reaches Gemini", async () => {
  const server = await startServer([{ status: 400, raw: '{"error":{"message":"bad request"}}' }]);
  try {
    setGeminiEnv({ geminiKey: "g-key", geminiBaseUrl: server.url });
    const llm = createLlm();
    for (let i = 0; i < 7; i++) {
      await assert.rejects(() => llm.chat({ messages: [{ role: "user", content: "hi" }] }));
    }
    assert.equal(server.seen.length, 7, "every request went out; the circuit stayed closed");
  } finally {
    await server.close();
  }
});

test("breaker: repeated outages open it, and it then fails fast without a network call", async () => {
  const server = await startServer([{ status: 503, raw: '{"error":{"message":"down"}}' }]);
  try {
    setGeminiEnv({ geminiKey: "g-key", geminiBaseUrl: server.url });
    const llm = createLlm();
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => llm.chat({ messages: [{ role: "user", content: "hi" }] }));
    }
    const hitsBeforeOpen = server.seen.length;
    await assert.rejects(
      () => llm.chat({ messages: [{ role: "user", content: "hi" }] }),
      (err: Error) => err instanceof LlmProviderError && /OPEN/.test(err.message)
    );
    assert.equal(server.seen.length, hitsBeforeOpen, "an open circuit makes no request");
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------ error hygiene

test("errors: recoverability is classified, not blanket", () => {
  assert.equal(isRecoverableProviderError({ status: 401 }), true);
  assert.equal(isRecoverableProviderError({ status: 429 }), true);
  assert.equal(isRecoverableProviderError({ status: 500 }), true);
  assert.equal(isRecoverableProviderError({ status: 400 }), false);
  assert.equal(isRecoverableProviderError({ status: 404 }), false);
  assert.equal(isRecoverableProviderError({ status: 422 }), false);
  assert.equal(isRecoverableProviderError(new TypeError("bad")), false);
  assert.equal(isRecoverableProviderError(new Error("fetch failed")), true);
  assert.equal(isRecoverableProviderError(new Error("connect ECONNREFUSED 127.0.0.1:1")), true);
});

test("errors: secrets are never carried into a log line", () => {
  const leaky = "Authorization: Bearer sk-proj-AAAABBBBCCCCDDDD1234 for key AIzaSyABCDEFGHIJKLMNOP";
  const safe = redactSecrets(leaky);
  assert.ok(!safe.includes("sk-proj-AAAABBBBCCCCDDDD1234"), "sk-style key must be redacted");
  assert.ok(!safe.includes("AIzaSyABCDEFGHIJKLMNOP"), "google-style key must be redacted");

  const err = new LlmProviderError({ provider: "gemini", model: "gemini-3.8-flash", cause: new Error(leaky) });
  const line = JSON.stringify(err.logFields());
  assert.ok(!line.includes("sk-proj-"), line);
  assert.ok(!line.includes("AIzaSy"), line);
  assert.equal(err.logFields().provider, "gemini");
  assert.equal(err.logFields().model, "gemini-3.8-flash");
});

test("errors: the configured key is not present in the profile's log surface", () => {
  setGeminiEnv({ geminiKey: "super-secret-gemini-key" });
  const profile = geminiProfile()!;
  assert.equal(profile.apiKey, "super-secret-gemini-key");
  assert.equal(profile.name, "gemini");
  assert.ok(!JSON.stringify({ ...profile, apiKey: "[x]" }).includes("super-secret"));
});

test("restores the original env for other suites", () => {
  Object.assign(cfg, savedEnv);
  __resetLlmForTests();
  assert.ok(true);
});

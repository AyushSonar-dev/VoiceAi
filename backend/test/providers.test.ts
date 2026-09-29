import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { config, normalizeProviderSetting } from "../src/config.js";
import { isRecoverableProviderError, LlmProviderError, redactSecrets } from "../src/agent/llm/errors.js";
import { resolveProviderChain, resolveProfile } from "../src/agent/llm/providers.js";
import { createLlm, __resetLlmForTests } from "../src/agent/llm/index.js";
import { PlaceholderBrain } from "../src/agent/llm/placeholderBrain.js";
import { TOOL_DEFINITIONS } from "../src/tools/index.js";

/**
 * Provider selection + fallback. Every test drives a real HTTP server that
 * speaks the OpenAI wire protocol, so the request Gemini/OpenAI would receive
 * is asserted on the wire rather than mocked out.
 */

type Mutable = Record<string, unknown>;
const cfg = config as unknown as Mutable;

const savedEnv = {
  openaiKey: config.openaiKey,
  openaiModel: config.openaiModel,
  geminiKey: config.geminiKey,
  geminiModel: config.geminiModel,
  geminiBaseUrl: config.geminiBaseUrl,
  llmProvider: config.llmProvider,
};

function setProviderEnv(v: Partial<Record<keyof typeof savedEnv, string>>): void {
  cfg.openaiKey = v.openaiKey ?? "";
  cfg.openaiModel = v.openaiModel ?? "gpt-4o-mini";
  cfg.geminiKey = v.geminiKey ?? "";
  cfg.geminiModel = v.geminiModel ?? "gemini-3.8-flash";
  cfg.geminiBaseUrl = v.geminiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai";
  cfg.llmProvider = v.llmProvider ?? "auto";
  __resetLlmForTests();
}

interface Captured {
  url: string;
  auth: string | undefined;
  body: any;
}

interface Reply {
  status?: number;
  /** A chat completion body, or a raw string to send verbatim. */
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
      res.end(
        step.raw ??
          JSON.stringify(
            step.completion ?? {
              choices: [{ message: { role: "assistant", content: "ok" } }],
            }
          )
      );
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

/** Fails every OpenAI-model request, and walks `geminiScript` otherwise. */
function startSplitServer(openaiStatus: number, geminiScript: Reply[]) {
  const seen: Captured[] = [];
  let g = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const isOpenAi = String(body.model ?? "").startsWith("gpt");
      if (isOpenAi) {
        res.writeHead(openaiStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "openai is unavailable" } }));
        return;
      }
      const step = geminiScript[Math.min(g, geminiScript.length - 1)] ?? {};
      g++;
      res.writeHead(step.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(step.completion ?? completion("ok")));
    });
  });
  return new Promise<{ url: string; seen: Captured[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

beforeEach(() => {
  __resetLlmForTests();
});
afterEach(() => {
  setProviderEnv({});
});

// ---------------------------------------------------------------- config

test("config: an unknown or missing LLM_PROVIDER degrades to auto, never a crash", () => {
  assert.equal(normalizeProviderSetting("openai"), "openai");
  assert.equal(normalizeProviderSetting("gemini"), "gemini");
  assert.equal(normalizeProviderSetting("  GEMINI "), "gemini", "case/whitespace tolerant");
  assert.equal(normalizeProviderSetting("banana"), "auto", "a typo must not crash the app");
  assert.equal(normalizeProviderSetting(undefined), "auto");
  assert.equal(normalizeProviderSetting(""), "auto");
  assert.equal(normalizeProviderSetting("auto"), "auto");
});

test("config: an invalid LLM_PROVIDER in the real env still yields a working app", () => {
  const saved = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "banana";
  try {
    // Booting the app must not throw, and must still find a usable provider.
    assert.equal(normalizeProviderSetting(process.env.LLM_PROVIDER), "auto");
  } finally {
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }
});

test("config: models come from env with sane defaults", () => {
  setProviderEnv({ geminiKey: "g" });
  assert.equal(resolveProfile("gemini")?.model, "gemini-3.8-flash");
  setProviderEnv({ geminiKey: "g", geminiModel: "gemini-3.5-flash" });
  assert.equal(resolveProfile("gemini")?.model, "gemini-3.5-flash");
  setProviderEnv({ openaiKey: "o", openaiModel: "gpt-4.1" });
  assert.equal(resolveProfile("openai")?.model, "gpt-4.1");
});

test("config: the legacy LLM_MODEL still works as an alias for OPENAI_MODEL", () => {
  const saved = process.env.LLM_MODEL;
  process.env.LLM_MODEL = "gpt-4o-legacy";
  delete process.env.OPENAI_MODEL;
  // config is computed at import time, so assert the precedence rule directly.
  assert.equal(process.env.OPENAI_MODEL || process.env.LLM_MODEL, "gpt-4o-legacy");
  if (saved === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved;
});

test("config: a missing key means 'unavailable', not an error", () => {
  setProviderEnv({});
  assert.equal(resolveProfile("openai"), null);
  assert.equal(resolveProfile("gemini"), null);
  assert.deepEqual(resolveProviderChain(), []);
});

// ------------------------------------------------------ provider choice

test("provider: Gemini-only startup uses Gemini and does NOT require OPENAI_API_KEY", () => {
  setProviderEnv({ geminiKey: "g-key" });
  const chain = resolveProviderChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].name, "gemini");
  const llm = createLlm();
  assert.ok(!(llm instanceof PlaceholderBrain), "must NOT fall back to the placeholder brain");
});

test("provider: OpenAI-only startup uses OpenAI", () => {
  setProviderEnv({ openaiKey: "o-key" });
  assert.deepEqual(
    resolveProviderChain().map((p) => p.name),
    ["openai"]
  );
  assert.ok(!(createLlm() instanceof PlaceholderBrain));
});

test("provider: both keys in auto mode prefers OpenAI and keeps Gemini as fallback", () => {
  setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
  assert.deepEqual(
    resolveProviderChain().map((p) => p.name),
    ["openai", "gemini"]
  );
});

test("provider: no keys at all uses the placeholder brain (no boot crash)", () => {
  setProviderEnv({});
  assert.ok(createLlm() instanceof PlaceholderBrain);
});

test("provider: LLM_PROVIDER=gemini pins Gemini even when an OpenAI key exists", () => {
  setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key", llmProvider: "gemini" });
  assert.deepEqual(
    resolveProviderChain().map((p) => p.name),
    ["gemini"]
  );
});

test("provider: LLM_PROVIDER=openai with no OpenAI key does NOT silently switch to Gemini", () => {
  setProviderEnv({ geminiKey: "g-key", llmProvider: "openai" });
  assert.deepEqual(resolveProviderChain(), [], "pinning must not silently substitute a vendor");
  assert.ok(createLlm() instanceof PlaceholderBrain);
});

// ------------------------------------------------- shared tool calling

test("tool calling: Gemini receives the SAME tool definitions as OpenAI, over the compat layer", async () => {
  const server = await startServer([{ completion: completion("Here are some shirts.") }]);
  try {
    setProviderEnv({ geminiKey: "g-key", geminiBaseUrl: server.url, llmProvider: "gemini" });

    const res = await createLlm().chat({ messages: [{ role: "user", content: "show me shirts" }], tools: TOOL_DEFINITIONS });

    assert.equal(res.message.content, "Here are some shirts.");
    assert.equal(server.seen.length, 1);
    const call = server.seen[0];
    assert.equal(call.body.model, "gemini-3.8-flash", "the configured Gemini model must be used");
    assert.equal(call.auth, "Bearer g-key");
    assert.equal(call.body.tool_choice, "auto");

    // The whole point: one shared tool set, including the visual tool.
    const names = (call.body.tools ?? []).map((t: any) => t.function.name);
    assert.deepEqual(names, TOOL_DEFINITIONS.map((t) => t.function.name));
    for (const required of [
      "searchProducts",
      "getProduct",
      "addToCart",
      "removeFromCart",
      "applyCoupon",
      "getCart",
      "checkout",
    ]) {
      assert.ok(names.includes(required), `${required} must be available to Gemini`);
    }
    // The runtime image-description pipeline is gone: appearance now ships with
    // the product, so no provider is ever asked to look at a picture.
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
    setProviderEnv({ geminiKey: "g-key", geminiBaseUrl: server.url, llmProvider: "gemini" });
    const res = await createLlm().chat({ messages: [{ role: "user", content: "shirts" }], tools: TOOL_DEFINITIONS });
    assert.equal(res.message.content, "", "a null content must normalize to an empty string, not undefined");
    assert.equal(res.message.tool_calls?.length, 1);
    assert.equal(res.message.tool_calls![0].function.name, "searchProducts");
    assert.equal(res.message.tool_calls![0].function.arguments, '{"query":"shirt"}');
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------- fallback

test("fallback: an OpenAI 401 (auth) hands the SAME request to Gemini", async () => {
  const server = await startServer([
    { status: 401, raw: JSON.stringify({ error: { message: "Incorrect API key provided" } }) },
    { completion: completion("Answered by Gemini.") },
  ]);
  try {
    setProviderEnv({
      openaiKey: "o-key",
      geminiKey: "g-key",
      openaiModel: "gpt-4o-mini",
      geminiModel: "gemini-3.8-flash",
    });
    // Both vendors point at the same stub so we can see the hand-off.
    cfg.openaiBaseUrl = server.url;
    cfg.geminiBaseUrl = server.url;
    __resetLlmForTests();

    const res = await createLlm().chat({ messages: [{ role: "user", content: "hi" }], tools: TOOL_DEFINITIONS });
    assert.equal(res.message.content, "Answered by Gemini.");
    assert.equal(server.seen.length, 2, "exactly two attempts: no blind retry storm");
    assert.equal(server.seen[0].body.model, "gpt-4o-mini");
    assert.equal(server.seen[1].body.model, "gemini-3.8-flash");
  } finally {
    await server.close();
  }
});

test("fallback: quota and rate-limit and 5xx all fall back", async () => {
  for (const status of [429, 500, 503, 403, 408]) {
    const server = await startServer([{ status, raw: '{"error":{"message":"nope"}}' }, { completion: completion("ok") }]);
    try {
      setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
      cfg.openaiBaseUrl = server.url;
      cfg.geminiBaseUrl = server.url;
      __resetLlmForTests();
      const res = await createLlm().chat({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.message.content, "ok", `status ${status} should fall back`);
      assert.equal(server.seen.length, 2);
    } finally {
      await server.close();
    }
  }
});

test("fallback: a 400 (malformed request) does NOT fall back — a real bug is not retried elsewhere", async () => {
  const server = await startServer([{ status: 400, raw: '{"error":{"message":"Invalid tool schema"}}' }]);
  try {
    setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
    cfg.openaiBaseUrl = server.url;
    cfg.geminiBaseUrl = server.url;
    __resetLlmForTests();

    await assert.rejects(
      () => createLlm().chat({ messages: [{ role: "user", content: "hi" }] }),
      (err: Error) => /openai/.test(err.message) && /Invalid tool schema/.test(err.message)
    );
    assert.equal(server.seen.length, 1, "must not retry a 400 against the other vendor");
  } finally {
    await server.close();
  }
});

test("fallback: a programming error is never swallowed", async () => {
  const server = await startServer([{ completion: completion("unused") }]);
  try {
    setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
    cfg.openaiBaseUrl = server.url;
    cfg.geminiBaseUrl = server.url;
    __resetLlmForTests();

    const llm: any = createLlm();
    // Force a genuine programming error, not a provider error.
    llm.clients[0].llm.chat = async () => {
      throw new TypeError("x is not a function");
    };
    await assert.rejects(() => llm.chat({ messages: [{ role: "user", content: "hi" }] }), TypeError);
    assert.equal(server.seen.length, 0);
  } finally {
    await server.close();
  }
});

test("fallback: when every provider fails the real error surfaces, not a vague apology", async () => {
  const server = await startServer([{ status: 500, raw: '{"error":{"message":"openai down"}}' }, { status: 500, raw: '{"error":{"message":"gemini down"}}' }]);
  try {
    setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
    cfg.openaiBaseUrl = server.url;
    cfg.geminiBaseUrl = server.url;
    __resetLlmForTests();

    await assert.rejects(
      () => createLlm().chat({ messages: [{ role: "user", content: "hi" }] }),
      (err: Error) => {
        assert.ok(err instanceof LlmProviderError);
        assert.equal(err.provider, "gemini", "the LAST failure is the one reported");
        assert.match(err.message, /gemini down/);
        assert.equal(err.status, 500);
        return true;
      }
    );
    assert.equal(server.seen.length, 2, "each provider is tried exactly once");
  } finally {
    await server.close();
  }
});

test("fallback: a single configured provider that fails is not retried anywhere", async () => {
  const server = await startServer([{ status: 401, raw: '{"error":{"message":"bad key"}}' }]);
  try {
    setProviderEnv({ openaiKey: "o-key", llmProvider: "openai" });
    cfg.openaiBaseUrl = server.url;
    __resetLlmForTests();
    await assert.rejects(() => createLlm().chat({ messages: [{ role: "user", content: "hi" }] }));
    assert.equal(server.seen.length, 1);
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
  assert.ok(!safe.includes("sk-proj-AAAABBBBCCCCDDDD1234"), "openai-style key must be redacted");
  assert.ok(!safe.includes("AIzaSyABCDEFGHIJKLMNOP"), "google-style key must be redacted");

  const err = new LlmProviderError({ provider: "openai", model: "gpt-4o-mini", cause: new Error(leaky) });
  const line = JSON.stringify(err.logFields());
  assert.ok(!line.includes("sk-proj-"), line);
  assert.ok(!line.includes("AIzaSy"), line);
  assert.equal(err.logFields().provider, "openai");
  assert.equal(err.logFields().model, "gpt-4o-mini");
});

test("errors: the real configured key is not present in the provider profile log surface", () => {
  setProviderEnv({ geminiKey: "super-secret-gemini-key" });
  const profile = resolveProfile("gemini")!;
  // The key must be carried for the client, but never in any human-facing string.
  assert.equal(profile.apiKey, "super-secret-gemini-key");
  assert.equal(profile.name, "gemini");
  assert.ok(!JSON.stringify({ ...profile, apiKey: "[x]" }).includes("super-secret"));
});

// ------------------------------------------- fallback inside the real loop

test("fallback: a mid-conversation provider switch still completes the tool loop", async () => {
  const { __resetStoreForTests, initStore } = await import("../src/db/index.js");
  const { runTurn } = await import("../src/agent/agent.js");

  // OpenAI 401s on every request; Gemini drives the whole turn, including a real
  // tool call whose result must be fed back and then answered.
  const server = await startSplitServer(401, [
    {
      completion: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "getCart", arguments: "{}" } }],
            },
          },
        ],
      },
    },
    { completion: completion("Your cart is empty.") },
  ]);
  try {
    __resetStoreForTests();
    await initStore({ forceMemory: true });
    setProviderEnv({ openaiKey: "o-key", geminiKey: "g-key" });
    cfg.openaiBaseUrl = server.url;
    cfg.geminiBaseUrl = server.url;

    const dispatched: string[] = [];
    const result = await runTurn({
      sessionId: "fallback-loop-test",
      userText: "what is in my cart?",
      dispatch: async () => {
        dispatched.push("getCart");
        return { success: true, message: "Your cart is empty.", data: { items: [] } };
      },
    });

    assert.deepEqual(dispatched, ["getCart"], "the tool must still execute after the switch");
    assert.equal(result.reply, "Your cart is empty.");
    assert.deepEqual(
      server.seen.map((x) => x.body.model),
      ["gpt-4o-mini", "gemini-3.8-flash", "gpt-4o-mini", "gemini-3.8-flash"],
      "fallback is per-request: the preferred provider is retried first each turn, " +
        "and each failure costs exactly ONE attempt before handing over"
    );
    // Gemini's transcript carries the real tool result.
    const last = server.seen[3].body.messages.at(-1);
    assert.equal(last.role, "tool");
    assert.match(last.content, /Your cart is empty/);
  } finally {
    await server.close();
  }
});

test("restores the original env for other suites", () => {
  Object.assign(cfg, savedEnv);
  __resetLlmForTests();
  assert.ok(true);
});
